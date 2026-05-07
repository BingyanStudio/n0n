/**
 * 助手侧消息类型
 */

import type { ToolCallRecord, PartialToolCallRecord } from "./tools/index.ts";

// ── 助手消息 ──

export interface AssistantTextMessage {
	type: "assistant_text";
	content: string;
	reasoning?: string | null;
	reasoningSignature?: string | null;
}

export interface AssistantToolCallMessage {
	type: "assistant_tool_call";
	content: string | null;
	reasoning?: string | null;
	reasoningSignature?: string | null;
	toolCalls: (ToolCallRecord | PartialToolCallRecord)[];
}

// ── 通用工具消息（内部子循环使用） ──

/**
 * 通用 assistant tool call 消息 — 用于内部子循环（editor-loop 等）的非标准工具。
 * 与 AssistantToolCallMessage 不同，toolCalls 不受 ToolCallRecord 判别联合约束。
 */
export interface GenericAssistantToolCallMessage {
	type: "generic_tool_call";
	content: string | null;
	toolCalls: Array<{ id: string; tool: string; args: Record<string, unknown> }>;
}

/**
 * 通用 tool result 消息 — 预格式化的纯文本结果。
 * formatPrompt 直接透传 content，不做额外格式化。
 */
export interface GenericToolResultMessage {
	type: "generic_tool_result";
	callId: string;
	toolName: string;
	content: string;
}
