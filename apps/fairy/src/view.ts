/**
 * View — 从状态组装上下文
 *
 * 核心创新：不直接使用对话历史，而是从全局状态重建上下文。
 *
 * 上下文组装顺序（前缀稳定，尾部动态）：
 * 1. [system] 身份设定（identity.md）         ← 最稳定
 * 2. [system] 对话路径摘要（reminder + user）  ← 较稳定（只追加）
 * 3. [system] 记忆和偏好（memory.md）          ← 半动态
 * 4. [system] 环境感知（时间、平台）            ← 动态
 * 5. [stimulus] 当前刺激                       ← 尾部
 */

import type { DomainMessage } from "@n0n/types";
import fairyPromptText from "./prompts/fairy.md" with { type: "text" };
import type { FairyPaths } from "./state.ts";
import { loadMarkdown } from "./state.ts";

/**
 * 从全局对话记录中提取对话路径摘要。
 *
 * 只保留 reminder 调用（从 assistant_tool_call 中提取）和 user_input 消息，
 * 形成天然的结构化摘要——不需要额外的总结算法。
 */
export function extractConversationPath(history: DomainMessage[]): string {
	const lines: string[] = [];

	for (const msg of history) {
		if (msg.type === "user_input") {
			lines.push(`[user] ${msg.content}`);
		} else if (msg.type === "assistant_tool_call") {
			for (const tc of msg.toolCalls) {
				if (tc.tool === "reminder") {
					lines.push(`[progress] ${tc.args.content}`);
				}
			}
		}
	}

	return lines.join("\n");
}

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
	const systemPrompt = buildSystemPrompt(identity);
	messages.push({ type: "system", content: systemPrompt });

	// 2. 对话路径摘要（较稳定，只追加）
	const conversationPath = extractConversationPath(history);
	if (conversationPath) {
		messages.push({
			type: "system",
			content: buildConversationPathContext(conversationPath),
		});
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

// ── 内部构建函数 ──

function buildSystemPrompt(identity: string): string {
	return [fairyPromptText, "", "---", "", identity].join("\n");
}

function buildConversationPathContext(path: string): string {
	return [
		"## Conversation History (Summary)",
		"",
		"Below is a condensed path of our previous interactions.",
		"Each [user] line is what the user said; each [progress] line is your own progress note from that round.",
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
