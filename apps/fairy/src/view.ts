/**
 * View — 从状态组装上下文
 *
 * 核心创新：不直接使用对话历史，而是从全局状态重建上下文。
 *
 * 上下文组装顺序（前缀稳定，尾部动态）：
 * 1. [system] 身份设定（identity.md）         ← 最稳定
 * 2. [system] 对话路径摘要（跳变窗口）         ← 较稳定（跳变更新，命中缓存）
 * 3. [system] 近期原始对话（尾部窗口）         ← 动态（最近几轮完整对话）
 * 4. [system] 记忆和偏好（memory.md）          ← 半动态
 * 5. [system] 环境感知（时间、平台）            ← 动态
 * 6. [stimulus] 当前刺激                       ← 尾部
 */

import type { DomainMessage } from "@n0n/types";
import fairyPromptText from "./prompts/fairy.md" with { type: "text" };
import type { FairyPaths } from "./state.ts";
import { loadMarkdown } from "./state.ts";

// ── 配置 ──

/**
 * 进入摘要模式的最小轮次数。
 * 低于此数量时，直接使用原始对话历史（无需摘要）。
 */
const SUMMARY_THRESHOLD = 6;

/**
 * 跳变窗口步长：摘要每积累 STEP 轮新对话才更新一次。
 * 这样摘要部分在连续几轮对话中保持不变，最大化 KV-cache 命中。
 */
const SUMMARY_STEP = 4;

/**
 * 尾部保留的最近轮次数（原始对话，不做摘要）。
 * 保证模型能看到最近的完整交互细节。
 */
const TAIL_ROUNDS = 3;

// ── 对话路径提取 ──

interface ConversationRound {
	/** 该轮在 history 中的起始索引 */
	startIdx: number;
	/** 该轮在 history 中的结束索引（不含） */
	endIdx: number;
}

/**
 * 将扁平的 DomainMessage[] 按轮次分割。
 * 每轮以 user_input 开始，到下一个 user_input 之前结束。
 */
function splitRounds(history: DomainMessage[]): ConversationRound[] {
	const rounds: ConversationRound[] = [];
	let currentStart = -1;

	for (let i = 0; i < history.length; i++) {
		if (history[i]?.type === "user_input") {
			if (currentStart >= 0) {
				rounds.push({ startIdx: currentStart, endIdx: i });
			}
			currentStart = i;
		}
	}
	// 最后一轮
	if (currentStart >= 0) {
		rounds.push({ startIdx: currentStart, endIdx: history.length });
	}

	return rounds;
}

/**
 * 从一段对话历史中提取路径摘要行。
 *
 * 提取 user_input、submit 回复、reminder 进度——
 * 三者共同构成完整的对话路径。
 */
function extractPathLines(messages: DomainMessage[]): string[] {
	const lines: string[] = [];

	for (const msg of messages) {
		if (msg.type === "user_input") {
			lines.push(`[user] ${msg.content}`);
		} else if (msg.type === "assistant_tool_call") {
			for (const tc of msg.toolCalls) {
				if (tc.tool === "reminder") {
					lines.push(`[progress] ${tc.args.content}`);
				} else if (tc.tool === "submit") {
					const result = tc.args.result as
						| { reply?: string }
						| null
						| undefined;
					const reply = result?.reply;
					if (reply) {
						lines.push(`[fairy] ${reply}`);
					}
				}
			}
		}
	}

	return lines;
}

// ── 主构建函数 ──

/**
 * 从状态 + 刺激源组装 DomainMessage[]，供 agentLoop 消费。
 */
export function buildView(
	history: DomainMessage[],
	paths: FairyPaths,
	stimulus: string,
): DomainMessage[] {
	const messages: DomainMessage[] = [];
	const rounds = splitRounds(history);

	// 1. 身份设定（最稳定前缀）
	const identity = loadMarkdown(paths.identityFile);
	messages.push({ type: "system", content: buildSystemPrompt(identity) });

	// 2. 对话路径摘要 + 尾部原始对话
	if (rounds.length >= SUMMARY_THRESHOLD) {
		// 跳变窗口：摘要覆盖到 snapEnd，尾部保留 TAIL_ROUNDS 轮原始对话
		const snapEnd = computeSnapshotEnd(
			rounds.length,
			TAIL_ROUNDS,
			SUMMARY_STEP,
		);
		const summaryMessages = history.slice(0, rounds[snapEnd]?.startIdx ?? 0);
		const pathLines = extractPathLines(summaryMessages);

		if (pathLines.length > 0) {
			messages.push({
				type: "system",
				content: buildConversationPathContext(pathLines.join("\n")),
			});
		}

		// 尾部原始对话：从 snapEnd 开始的完整轮次
		const tailStart = rounds[snapEnd]?.startIdx ?? 0;
		const tailMessages = history.slice(tailStart);
		for (const msg of tailMessages) {
			messages.push(msg);
		}
	} else if (history.length > 0) {
		// 对话数不足，直接使用全部原始历史
		for (const msg of history) {
			messages.push(msg);
		}
	}

	// 3. 记忆和偏好（半动态）
	const memory = loadMarkdown(paths.memoryFile);
	if (memory.trim()) {
		messages.push({
			type: "system",
			content: buildMemoryContext(memory),
		});
	}

	// 4. 环境感知（动态）
	messages.push({
		type: "system",
		content: buildEnvironmentContext(paths),
	});

	// 5. 当前刺激（尾部）
	messages.push({
		type: "user_input",
		content: stimulus,
		context: null,
		capabilities: null,
	});

	return messages;
}

/**
 * 计算摘要快照的结束轮次索引（跳变窗口）。
 *
 * 摘要覆盖 [0, snapEnd) 轮，尾部保留 [snapEnd, total) 轮原始对话。
 * snapEnd 按 step 跳变：只有当新轮次积累到 step 的整数倍时才前进，
 * 这样连续几轮对话中摘要部分保持不变，最大化 KV-cache 命中。
 *
 * 例如 step=4, tail=3:
 *   rounds=6  → snapEnd = floor((6-3)/4)*4 = floor(0.75)*4 = 0  → 但 >=threshold 所以至少 = max(0, 6-3) 的跳变
 *   rounds=7  → snapEnd = floor((7-3)/4)*4 = 4
 *   rounds=10 → snapEnd = floor((10-3)/4)*4 = 4
 *   rounds=11 → snapEnd = floor((11-3)/4)*4 = 8
 */
export function computeSnapshotEnd(
	totalRounds: number,
	tailSize: number,
	step: number,
): number {
	const available = totalRounds - tailSize;
	if (available <= 0) return 0;
	return Math.floor(available / step) * step;
}

// ── 内部构建函数 ──

function buildSystemPrompt(identity: string): string {
	return [fairyPromptText, "", "---", "", identity].join("\n");
}

function buildConversationPathContext(path: string): string {
	return [
		"## Conversation History (Summary)",
		"",
		"Below is a condensed path of earlier interactions.",
		"[user] = what the user said; [fairy] = your reply; [progress] = your progress note.",
		"",
		path,
	].join("\n");
}

function buildMemoryContext(memory: string): string {
	return [
		"## Long-term Memory",
		"",
		"This is your persistent memory file. You can update it via the `edit` tool.",
		"File path: `memory.md`",
		"",
		memory,
	].join("\n");
}

function buildEnvironmentContext(paths: FairyPaths): string {
	return [
		"## Environment",
		"",
		`- current_time: ${new Date().toISOString()}`,
		`- workspace: ${paths.workspace}`,
		`- identity_file: identity.md (edit to change your persona)`,
		`- memory_file: memory.md (edit to update your long-term memory)`,
		`- history_file: history.json (read-only, managed by the system)`,
	].join("\n");
}
