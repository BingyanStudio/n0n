/**
 * DomainMessage — 领域消息类型
 *
 * 标准领域设计：内部只记录数据，具体提示词转换由统一 adapter 层负责。
 * 判别联合类型（discriminated union），每种类型字段完整、无可选参数。
 */

// ── 系统消息 ──
export interface SystemMessage {
	type: "system";
	content: string;
}

// ── 用户消息 ──
export interface UserTextMessage {
	type: "user_text";
	content: string;
}

export interface UserImageMessage {
	type: "user_image";
	text: string;
	imagePath: string;
	focusX: number;
	focusY: number;
	scale: number;
}

// ── 助手消息 ──
export interface AssistantTextMessage {
	type: "assistant_text";
	content: string;
}

export interface AssistantToolCallMessage {
	type: "assistant_tool_call";
	content: string | null;
	toolCalls: ToolCallRecord[];
}

// ── 工具调用记录 ──
export interface ToolCallRecord {
	id: string;
	tool: string;
	args: Record<string, unknown>;
}

// ── 工具结果 ──
export interface ExecToolResult {
	type: "tool_result";
	callId: string;
	tool: "exec";
	command: string;
	cwd: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
}

export interface WriteToolResult {
	type: "tool_result";
	callId: string;
	tool: "write";
	path: string;
	searchPattern: string;
	replacedCount: number;
	success: boolean;
	error: string | null;
}

export interface ReminderToolResult {
	type: "tool_result";
	callId: string;
	tool: "reminder";
	content: string;
	delay: number;
	acknowledged: true;
}

export interface SubmitToolResult {
	type: "tool_result";
	callId: string;
	tool: "submit";
	result: unknown;
	report: string | null;
}

export interface GenericToolResult {
	type: "tool_result";
	callId: string;
	tool: string;
	[key: string]: unknown;
}

export type ToolResult =
	| ExecToolResult
	| WriteToolResult
	| ReminderToolResult
	| SubmitToolResult
	| GenericToolResult;

export function isExecToolResult(msg: ToolResult): msg is ExecToolResult {
	return msg.tool === "exec";
}

export function isWriteToolResult(msg: ToolResult): msg is WriteToolResult {
	return msg.tool === "write";
}

export function isReminderToolResult(msg: ToolResult): msg is ReminderToolResult {
	return msg.tool === "reminder";
}

export function isSubmitToolResult(msg: ToolResult): msg is SubmitToolResult {
	return msg.tool === "submit" && "result" in msg;
}

// ── 联合类型 ──
export type DomainMessage =
	| SystemMessage
	| UserTextMessage
	| UserImageMessage
	| AssistantTextMessage
	| AssistantToolCallMessage
	| ToolResult;
