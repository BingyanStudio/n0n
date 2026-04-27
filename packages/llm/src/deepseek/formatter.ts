/**
 * DeepSeek 消息格式转换
 *
 * PromptMessage → DeepSeekMessage 转换，工具定义转换，Task Token 解析。
 */

import type { PromptMessage, ToolDefinition } from "@n0n/types";

// ── DeepSeek API 消息类型 ──

export interface DeepSeekMessage {
	role:
		| "system"
		| "user"
		| "assistant"
		| "tool"
		| "developer"
		| "latest_reminder";
	content: string | null;
	reasoning_content?: string | null;
	tool_calls?: DeepSeekToolCall[];
	tool_call_id?: string;
	task?: string;
}

export interface DeepSeekToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export interface DeepSeekToolDef {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

// ── PromptMessage → DeepSeek Message 转换 ──

export function toDeepSeekMessages(
	promptMessages: PromptMessage[],
	enableThinking: boolean,
): DeepSeekMessage[] {
	const result: DeepSeekMessage[] = [];

	for (const msg of promptMessages) {
		switch (msg.role) {
			case "system":
				result.push({ role: "system", content: msg.content });
				break;

			case "user":
				result.push({ role: "user", content: msg.content });
				break;

			case "assistant": {
				if (msg.toolCalls?.length) {
					const toolCalls: DeepSeekToolCall[] = msg.toolCalls.map(
						(tc) => ({
							id: tc.id,
							type: "function" as const,
							function: {
								name: tc.tool,
								arguments: JSON.stringify(tc.args),
							},
						}),
					);
					result.push({
						role: "assistant",
						content: msg.content || null,
						...(enableThinking
							? { reasoning_content: msg.reasoning ?? "" }
							: {}),
						tool_calls: toolCalls,
					});
				} else {
					result.push({
						role: "assistant",
						content: msg.content || null,
						...(enableThinking
							? { reasoning_content: msg.reasoning ?? "" }
							: {}),
					});
				}
				break;
			}

			case "tool":
				result.push({
					role: "tool",
					content: msg.content,
					tool_call_id: msg.toolCallId,
				});
				break;
		}
	}

	return result;
}

export function toDeepSeekTools(tools: ToolDefinition[]): DeepSeekToolDef[] {
	return tools.map((t) => ({
		type: "function" as const,
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		},
	}));
}

// ── Task Token 解析 ──

const VALID_TASKS = new Set([
	"action",
	"query",
	"authority",
	"domain",
	"title",
	"read_url",
]);
const TASK_PATTERN = /【【(\w+)】】/;

/**
 * 从所有 user 消息中剔除 【【task】】 标记并设置 task 字段。
 * 严格只匹配 role === "user"（用户手动输入），不匹配 developer 等系统消息。
 */
export function applyTaskToken(messages: DeepSeekMessage[]): void {
	for (const msg of messages) {
		if (msg.role !== "user") continue;

		const match = (msg.content ?? "").match(TASK_PATTERN);
		if (!match) continue;

		msg.content = (msg.content ?? "").replace(TASK_PATTERN, "").trim();

		const taskType = match[1]!;
		if (VALID_TASKS.has(taskType)) {
			msg.task = taskType;
		}
	}
}
