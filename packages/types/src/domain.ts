/**
 * DomainMessage — 领域消息类型
 *
 * 标准领域设计：内部只记录数据，具体提示词转换由统一 adapter 层负责。
 * 判别联合类型（discriminated union），每种类型字段完整、无可选参数。
 */

// ── 系统消息 ──
export interface RawSystemMessage {
	type: "system";
	content: string;
}

// ── 用户消息 ──
export interface RawUserTextMessage {
	type: "user_text";
	content: string;
}

/** 真实用户输入（交互模式），adapter 负责包装为设计线索并拼接上下文 */
export interface UserInputMessage {
	type: "user_input";
	content: string;
	context: string | null;
	capabilities: string | null;
	/** 注入到用户消息末尾的行为引导提示，各 app 自行定义。null 时 adapter 不追加额外提示。 */
	hint: string | null;
}

/** submit 后的轮次反馈（系统注入），adapter 负责生成具体提示词 */
export interface TurnFeedbackMessage {
	type: "turn_feedback";
	status: "accepted" | "rejected";
	resultType: string;
	detail: string;
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
	reasoning?: string | null;
}

export interface AssistantToolCallMessage {
	type: "assistant_tool_call";
	content: string | null;
	reasoning?: string | null;
	toolCalls: ToolCallRecord[];
}

// ── 工具调用记录（判别联合） ──
// 参数类型由 tool-args.ts 中的 Zod schema 推断（SSoT）

import type {
	EditArgs,
	ExecArgs,
	ReminderArgs,
	SubmitArgs,
	WriteArgs,
} from "./tool-args.ts";

interface ToolCallBase {
	id: string;
}

export type ExecToolCall = ToolCallBase & { tool: "exec"; args: ExecArgs };
export type WriteToolCall = ToolCallBase & { tool: "write"; args: WriteArgs };
export type EditToolCall = ToolCallBase & { tool: "edit"; args: EditArgs };
export type ReminderToolCall = ToolCallBase & {
	tool: "reminder";
	args: ReminderArgs;
};
export type SubmitToolCall = ToolCallBase & {
	tool: "submit";
	args: SubmitArgs;
};

/**
 * 工具调用记录 — 判别联合，通过 tool 字段窄化 args 类型。
 * 参数类型来自 tool-args.ts 中的 Zod schema（z.infer），
 * 修改 schema 字段时 tsc 会在所有消费方报错。
 */
export type ToolCallRecord =
	| ExecToolCall
	| WriteToolCall
	| EditToolCall
	| ReminderToolCall
	| SubmitToolCall;

// ── 工具结果 ──
// 每个 Result 嵌入原始 ToolCall（call 字段）。
// call = LLM 原始调用参数；顶层字段 = 执行产出。
// tool 字段与 call.tool 始终一致，用于判别联合窄化（TS 不支持嵌套属性窄化）。

interface ToolResultBase {
	type: "tool_result";
}

export type ExecToolResult = ToolResultBase & {
	tool: ExecToolCall["tool"]; // "exec"
	call: ExecToolCall;
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
};

export type WriteToolResult = ToolResultBase & {
	tool: WriteToolCall["tool"]; // "write"
	call: WriteToolCall;
	success: boolean;
	error: string | null;
};

export type EditToolResult = ToolResultBase & {
	tool: EditToolCall["tool"]; // "edit"
	call: EditToolCall;
	diff: string;
	success: boolean;
	error: string | null;
};

export type ReminderToolResult = ToolResultBase & {
	tool: ReminderToolCall["tool"]; // "reminder"
	call: ReminderToolCall;
	acknowledged: true;
};

export type SubmitToolResult = ToolResultBase & {
	tool: SubmitToolCall["tool"]; // "submit"
	call: SubmitToolCall;
	/** 经 extractSubmitResult 处理后的最终结果（有 schema 时 ≠ call.args.result） */
	cleanedResult: unknown;
	/** 用户对 submit 结果的回应（由 REPL 注入，非模型生成） */
	userResponse?: string;
};

export type ToolResult =
	| ExecToolResult
	| WriteToolResult
	| EditToolResult
	| ReminderToolResult
	| SubmitToolResult;

/** 工具执行过程中的流式输出 chunk（目前仅 exec 使用） */
export interface ToolOutputChunk {
	type: "tool_output_chunk";
	callId: string;
	tool: string;
	chunk: string;
}

/** 工具流式执行产出：chunk 或最终结果 */
export type ToolStreamEvent =
	| ToolOutputChunk
	| ToolResult
	| ToolArgErrorMessage;

// ── 空转提示 ──
export interface IdleNudgeMessage {
	type: "idle_nudge";
	idleCount: number;
	maxIdleRounds: number;
}

// ── 到期提醒 ──
/** reminder 到期时注入的消息，adapter 负责生成具体提示词 */
export interface ReminderDueMessage {
	type: "reminder:due";
	content: string;
}

// ── 工具参数错误 ──
/** 工具调用参数校验失败时注入的消息，包含错误详情和正确的工具 schema */
export interface ToolArgErrorMessage {
	type: "tool_arg_error";
	callId: string;
	tool: string;
	error: string;
	schema: Record<string, unknown>;
}

// ── 提交被拒 ──
/** submit 校验失败时注入的消息，adapter 负责生成具体提示词 */
export interface SubmitRejectedMessage {
	type: "submit:rejected";
	error: string;
	attempt: number;
	maxAttempts: number;
}

// ── 联合类型 ──
export type DomainMessage =
	| RawSystemMessage
	| RawUserTextMessage
	| UserInputMessage
	| UserImageMessage
	| AssistantTextMessage
	| AssistantToolCallMessage
	| ToolResult
	| IdleNudgeMessage
	| TurnFeedbackMessage
	| ReminderDueMessage
	| SubmitRejectedMessage
	| ToolArgErrorMessage;
