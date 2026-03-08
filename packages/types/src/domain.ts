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

/** 真实用户输入（交互模式），adapter 负责包装为设计线索并拼接上下文 */
export interface UserInputMessage {
	type: "user_input";
	content: string;
	context: string | null;
	capabilities: string | null;
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
}

export interface AssistantToolCallMessage {
	type: "assistant_tool_call";
	content: string | null;
	toolCalls: ToolCallRecord[];
}

// ── 工具参数类型（Single Source of Truth） ──
// Zod schema（@n0n/tools）应与这些接口保持一致；
// 修改字段时 tsc 会在所有消费方报错。
// 每个接口包含索引签名以兼容 Record<string, unknown>（LLM 可能传入额外字段）。

export interface ExecToolArgs {
	[key: string]: unknown;
	script: string;
	runtime?: string;
	cwd?: string;
	timeout?: number;
}

export interface WriteToolArgs {
	[key: string]: unknown;
	path: string;
	content: string;
}

export interface EditToolArgs {
	[key: string]: unknown;
	path: string;
	search: string;
	replace: string;
	expectedMatches?: number;
}

export interface ReminderToolArgs {
	[key: string]: unknown;
	content: string;
	delay?: number;
}

export interface SubmitToolArgs {
	[key: string]: unknown;
	result: unknown;
	report?: string;
}

/** 工具名 → 参数类型映射 */
export interface ToolArgsMap {
	exec: ExecToolArgs;
	write: WriteToolArgs;
	edit: EditToolArgs;
	reminder: ReminderToolArgs;
	submit: SubmitToolArgs;
}

export type ToolName = keyof ToolArgsMap;

// ── 工具调用记录（判别联合） ──

interface ToolCallBase {
	id: string;
}

export type ExecToolCall = ToolCallBase & {
	tool: "exec";
	args: ExecToolArgs;
};
export type WriteToolCall = ToolCallBase & {
	tool: "write";
	args: WriteToolArgs;
};
export type EditToolCall = ToolCallBase & {
	tool: "edit";
	args: EditToolArgs;
};
export type ReminderToolCall = ToolCallBase & {
	tool: "reminder";
	args: ReminderToolArgs;
};
export type SubmitToolCall = ToolCallBase & {
	tool: "submit";
	args: SubmitToolArgs;
};

/**
 * 工具调用记录 — 判别联合，通过 tool 字段窄化 args 类型。
 *
 * 仅包含已注册工具；LLM 可能发送未注册工具名，
 * 解析阶段使用 UntypedToolCall（未校验），执行阶段再窄化为 ToolCallRecord。
 */
export type ToolCallRecord =
	| ExecToolCall
	| WriteToolCall
	| EditToolCall
	| ReminderToolCall
	| SubmitToolCall;

/**
 * 未经类型校验的工具调用（parseToolCalls 的输出）。
 * tool 和 args 均为宽类型；执行器负责 Zod 校验后窄化。
 */
export interface UntypedToolCall extends ToolCallBase {
	tool: string;
	args: Record<string, unknown>;
}

// ── 工具结果 ──

export interface ExecToolResult {
	type: "tool_result";
	callId: string;
	tool: "exec";
	/** 来自 ExecToolArgs.script */
	script: string;
	/** 来自 ExecToolArgs.runtime */
	runtime: string;
	/** 来自 ExecToolArgs.cwd（执行时解析为绝对路径） */
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
	success: boolean;
	error: string | null;
}

export interface EditToolResult {
	type: "tool_result";
	callId: string;
	tool: "edit";
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
	/** 用户对 submit 结果的回应（由 REPL 注入，非模型生成） */
	userResponse?: string;
}

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
	| SystemMessage
	| UserTextMessage
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
