/**
 * View — 从状态组装上下文
 *
 * 核心创新：不直接使用对话历史，而是从全局状态重建上下文。
 *
 * 上下文组装策略（基于 token 预算）：
 * - 当原始历史 token 量 < 80% 上下文窗口时：直接使用原始历史
 * - 超过阈值后：压缩为摘要（~25k tokens）+ 尾部原始对话
 * - 摘要使用跳变窗口：每积累 STEP 轮新对话才更新一次，最大化 KV-cache 命中
 *
 * 上下文组装顺序（前缀稳定，尾部动态）：
 * 1. [system] 身份设定（identity.md）         ← 最稳定
 * 2. [system] 对话路径摘要（跳变窗口）         ← 较稳定（跳变更新）
 * 3. [历史/尾部] 原始对话消息                  ← 动态
 * 4. [system] 记忆和偏好（memory.md）          ← 半动态
 * 5. [system] 环境感知（时间、平台）            ← 动态
 * 6. [stimulus] 当前刺激                       ← 尾部
 */

import type { DomainMessage } from "@n0n/types";
import fairyPromptText from "./prompts/fairy.md" with { type: "text" };
import type { FairyPaths } from "./state.ts";
import { loadMarkdown } from "./state.ts";

// ── Token 预算配置 ──

/** 上下文窗口大小（tokens） */
const CONTEXT_WINDOW = 128_000;

/**
 * 触发压缩的阈值：当原始历史估算 token 量超过此值时，切换到摘要模式。
 * 设为上下文窗口的 80%，留 20% 给系统消息、记忆、环境和当前刺激。
 */
const COMPRESS_TRIGGER = Math.round(CONTEXT_WINDOW * 0.8);

/**
 * 跳变窗口步长（轮次）。
 * 摘要每积累 STEP 轮新对话才更新一次，保证连续对话中摘要前缀不变。
 * 较大的 step 意味着更高的缓存命中率，但尾部原始对话也更长。
 */
const SNAPSHOT_STEP = 20;

/**
 * 粗略的 token 估算：1 token ≈ 3 chars（中英混合场景）。
 * 不需要精确——只用于判断是否触发压缩。
 */
function estimateTokens(messages: DomainMessage[]): number {
	let chars = 0;
	for (const msg of messages) {
		if ("content" in msg && typeof msg.content === "string") {
			chars += msg.content.length;
		}
		if (msg.type === "assistant_tool_call") {
			for (const tc of msg.toolCalls) {
				chars += JSON.stringify(tc.args).length;
			}
		}
		if (msg.type === "tool_result") {
			if ("stdout" in msg) chars += msg.stdout?.length ?? 0;
			if ("stderr" in msg) chars += msg.stderr?.length ?? 0;
			if ("error" in msg && typeof msg.error === "string")
				chars += msg.error.length;
		}
	}
	return Math.round(chars / 3);
}

// ── 轮次分割 ──

interface ConversationRound {
	startIdx: number;
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
	if (currentStart >= 0) {
		rounds.push({ startIdx: currentStart, endIdx: history.length });
	}

	return rounds;
}

// ── 对话路径提取 ──

/**
 * 从一段对话历史中提取路径摘要行。
 * 提取 user_input、submit 回复、reminder 进度。
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

	// 1. 身份设定（最稳定前缀）
	const identity = loadMarkdown(paths.identityFile);
	messages.push({ type: "system", content: buildSystemPrompt(identity) });

	// 2. 判断是否需要压缩
	const historyTokens = estimateTokens(history);

	if (historyTokens < COMPRESS_TRIGGER) {
		// 未触发压缩：直接使用全部原始历史
		for (const msg of history) {
			messages.push(msg);
		}
	} else {
		// 触发压缩：摘要 + 尾部原始对话
		const rounds = splitRounds(history);
		const snapEnd = computeSnapshotEnd(rounds.length, SNAPSHOT_STEP);
		const summaryMessages = history.slice(0, rounds[snapEnd]?.startIdx ?? 0);
		const pathLines = extractPathLines(summaryMessages);

		if (pathLines.length > 0) {
			messages.push({
				type: "system",
				content: buildConversationPathContext(pathLines.join("\n")),
			});
		}

		// 尾部原始对话
		const tailStart = rounds[snapEnd]?.startIdx ?? 0;
		const tailMessages = history.slice(tailStart);
		for (const msg of tailMessages) {
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
 * snapEnd 按 step 跳变：只有当新轮次积累到 step 的整数倍时才前进。
 */
export function computeSnapshotEnd(totalRounds: number, step: number): number {
	// 至少保留 step 轮作为尾部
	const available = totalRounds - step;
	if (available <= 0) return 0;
	return Math.floor(available / step) * step;
}

// ── 内部构建函数 ──

/** 生成本地时区的 ISO 格式时间字符串 */
function localISOString(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
	const offset = -now.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const abs = Math.abs(offset);
	const tz = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
	return `${date}T${time}${tz}`;
}

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
		`- current_time: ${localISOString()}`,
		`- workspace: ${paths.workspace}`,
		`- identity_file: identity.md (edit to change your persona)`,
		`- memory_file: memory.md (edit to update your long-term memory)`,
		`- history_file: history.json (read-only, managed by the system)`,
	].join("\n");
}
