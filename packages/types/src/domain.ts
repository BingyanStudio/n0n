/**
 * DomainMessage — 领域消息类型
 *
 * 设计原则：
 * 1. 纯数据记录 — 只存储还原完整事件的必要信息，不包含任何提示词相关字段（role/content 等）。
 * 2. 严格类型 — 每种 DomainMessage 字段完整、无可选参数；用 discriminated union 表达变体，
 *    而非 `string | null` 妥协。
 * 3. 职责分离 — adapter 层（formatPrompt）负责将 DomainMessage 转换为 LLM 提示词格式。
 *    新增事件类型时只需定义新 DomainMessage + 对应 adapter case，互不耦合。
 * 4. 可持久化/可重放 — 纯数据结构天然支持序列化、存储和测试回放。
 *
 * 反例（禁止）：
 *   messages.push({ type: "generic_user_text", content: `⏰ REMINDER: ${r.content}\n\n⚠️ ...` });
 *   // ❌ 将提示词混入 DomainMessage
 *
 * 正例：
 *   messages.push({ type: "reminder:due", content: r.content });
 *   // ✅ adapter 层负责格式化为提示词
 */

// ── 通用系统消息 ──
export interface GenericSystemMessage {
	type: "system";
	content: string;
}

// ── 通用用户文本消息 ──
export interface GenericUserTextMessage {
	type: "generic_user_text";
	content: string;
}

/** 真实用户输入（交互模式），adapter 负责包装为设计线索并拼接上下文 */
export interface UserInputMessage {
	type: "user_input";
	content: string;
	context: string | null;
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
	reasoningSignature?: string | null;
}

export interface AssistantToolCallMessage {
	type: "assistant_tool_call";
	content: string | null;
	reasoning?: string | null;
	reasoningSignature?: string | null;
	toolCalls: (ToolCallRecord | PartialToolCallRecord)[];
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

/**
 * 截断恢复失败的不完整工具调用记录。
 * 仅 id 和 tool 字段有意义，args 为空对象。
 * 用于在 assistant_tool_call 消息中保持与 tool_arg_error result 的配对完整性。
 */
export interface PartialToolCallRecord {
	id: string;
	tool: string;
	args: Record<string, never>;
}

// ── 工具结果 ──
// 每个 Result 嵌入原始 ToolCall（call 字段）。
// call = LLM 原始调用参数；顶层字段 = 执行产出。
// tool 字段与 call.tool 始终一致，用于判别联合窄化（TS 不支持嵌套属性窄化）。

interface ToolResultBase {
	type: "tool_result";
}

/** exec 三态结果的公共字段 */
interface ExecResultBase extends ToolResultBase {
	tool: ExecToolCall["tool"];
	call: ExecToolCall;
	durationMs: number;
}

/** exec 正常完成，输出在阈值内 */
interface ExecCompleted extends ExecResultBase {
	status: "completed";
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** exec 正常完成，输出超长被截断并写入文件 */
interface ExecTruncated extends ExecResultBase {
	status: "truncated";
	exitCode: number;
	/** stdout 末尾截断内容 */
	stdoutTail: string;
	/** stderr 末尾截断内容 */
	stderrTail: string;
	/** 完整输出文件路径 */
	outputFile: string;
	/** 原始 stdout 总字符数 */
	stdoutLength: number;
	/** 原始 stderr 总字符数 */
	stderrLength: number;
	/** 原始输出总行数（stdout + stderr） */
	totalLines: number;
	/** 截断展示内容起始行号（从第几行开始展示） */
	tailStartLine: number;
	/** 被截断前半部分按 token 预算分块的行号范围，帮助模型精确分块读取 */
	truncatedChunks: { startLine: number; endLine: number; tokens: number }[];
}

/**  exec 等待超限，进程转入后台继续执行  */
interface ExecBackgrounded extends ExecResultBase {
	status: "backgrounded";
	/** 后台进程 PID */
	pid: number;
	/** 后台日志文件路径 */
	logFile: string;
	/** 超时前已捕获的 stdout */
	stdoutSoFar: string;
	/** 超时前已捕获的 stderr */
	stderrSoFar: string;
}

export type ExecToolResult = ExecCompleted | ExecTruncated | ExecBackgrounded;

/** write 结果的公共字段 */
interface WriteResultBase extends ToolResultBase {
	tool: WriteToolCall["tool"];
	call: WriteToolCall;
}

/** write 正常写入成功 */
interface WriteCompleted extends WriteResultBase {
	status: "completed";
}

/** write 写入失败 */
interface WriteFailed extends WriteResultBase {
	status: "failed";
	error: string;
}

/** write 从截断恢复后写入成功（内容不完整） */
interface WriteRecovered extends WriteResultBase {
	status: "recovered";
}

/** write 从截断恢复失败（参数无法解析） */
interface WriteRecoverFailed extends WriteResultBase {
	status: "recover_failed";
	error: string;
}

export type WriteToolResult =
	| WriteCompleted
	| WriteFailed
	| WriteRecovered
	| WriteRecoverFailed;

/** diff 中的单行 */
export interface DiffLine {
	/** 行号（基于新文件） */
	line: number;
	/** 行内容 */
	content: string;
	/** 是否为变更行（新增或修改） */
	changed: boolean;
}

/** diff 中的一个变更块 */
export interface DiffChunk {
	/** 块起始行号（基于新文件） */
	startLine: number;
	/** 块结束行号（基于新文件） */
	endLine: number;
	/** 块内各行 */
	lines: DiffLine[];
}

/** 结构化 diff — 纯数据，格式化由 adapter/renderer 各自负责 */
export interface EditDiff {
	/** 变更块列表 */
	chunks: DiffChunk[];
	/** 新增/修改的行数 */
	added: number;
	/** 删除的行数 */
	removed: number;
}

export type EditToolResult = ToolResultBase & {
	tool: EditToolCall["tool"]; // "edit"
	call: EditToolCall;
	diff: EditDiff;
	success: boolean;
	error: string | null;
	/** Editor LLM 对主模型编辑指令的反馈（过度指定/任务过大/过于模糊等），null 表示指令清晰 */
	feedback: string | null;
	/** Editor LLM 循环轮次数 */
	rounds: number;
	/** 编辑总耗时（毫秒） */
	durationMs: number;
};

export type ReminderToolResult = ToolResultBase & {
	tool: ReminderToolCall["tool"]; // "reminder"
	call: ReminderToolCall;
	acknowledged: true;
};

export type SubmitToolResult = ToolResultBase & {
	tool: SubmitToolCall["tool"]; // "submit"
	call: SubmitToolCall;
	/** submit 的结果值（等于 call.args，由 schema 后验证） */
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

/**
 * 工具执行结局 — scheduler 向消费者报告单个工具执行完成时的判别联合。
 * completed: 正常执行完毕，携带结果。
 * arg_error: 参数解析失败，无结果。
 */
export type ToolExecOutcome =
	| { status: "completed"; result: ToolResult }
	| { status: "arg_error" };

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
	/** 模型设置 reminder 时估算的原始轮数 */
	originalEstimate: number;
}

// ── 工具错误类型（纯数据，不含提示词） ──

/** 工具不存在于注册表中 */
export interface UnknownToolError {
	kind: "unknown_tool";
}

/** Zod 参数校验失败 */
export interface InvalidArgsError {
	kind: "invalid_args";
	issues: Array<{ path: string; message: string }>;
	schema?: Record<string, unknown>;
}

/** 流式输出截断导致参数不完整，恢复失败 */
export interface TruncatedRecoveryError {
	kind: "truncated_recovery";
}

/** 工具执行过程中的内部异常 */
export interface InternalExecutionError {
	kind: "internal_error";
	message: string;
}

/** 工具错误 — 判别联合，纯数据。adapter 层负责生成提示词。 */
export type ToolError =
	| UnknownToolError
	| InvalidArgsError
	| TruncatedRecoveryError
	| InternalExecutionError;

// ── 工具参数错误消息 ──
/** 工具调用失败时注入的领域消息。error 字段为纯数据，提示词由 adapter 层生成。 */
export interface ToolArgErrorMessage {
	type: "tool_arg_error";
	callId: string;
	tool: string;
	error: ToolError;
}

// ── 提交被拒 ──
/** submit 校验失败时注入的消息，adapter 负责生成具体提示词 */
export interface SubmitRejectedMessage {
	type: "submit:rejected";
	error: string;
	attempt: number;
	maxAttempts: number;
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

// ── 缓存断点 ──
/** 显式标记提示词缓存断点位置。client 层在此处设置 cache_control，提升前缀稳定性。 */
export interface CacheBreakpointMessage {
	type: "cache_breakpoint";
}

// ── Token 用量 ──
/** LLM 调用完成后的 token 用量统计，独立于 assistant 消息的领域事件 */
export interface TokenUsageMessage {
	type: "token_usage";
	/** 本轮 LLM 调用的 token 用量 */
	usage: import("./client.ts").TokenUsage;
	/** 对应的归一化完成原因（来自 FinishReason），便于消费方区分 stop / tool_calls / length / content_filter */
	finishReason: string;
}

// ── 联合类型 ──
export type DomainMessage =
	| GenericSystemMessage
	| GenericUserTextMessage
	| GenericAssistantToolCallMessage
	| GenericToolResultMessage
	| UserInputMessage
	| UserImageMessage
	| AssistantTextMessage
	| AssistantToolCallMessage
	| ToolResult
	| IdleNudgeMessage
	| TurnFeedbackMessage
	| ReminderDueMessage
	| SubmitRejectedMessage
	| ToolArgErrorMessage
	| CacheBreakpointMessage
	| TokenUsageMessage;

// ── 工具并行条件判断 ──

/**
 * 工具并行条件判断函数。
 * scheduler 在决定是否启动队首工具时调用。
 *
 * @param self 待启动的工具调用
 * @param active 当前正在执行的所有工具调用
 * @returns true 表示可以立即启动，false 表示需要等待
 */
export type CanStartFn = (
	self: ToolCallRecord,
	active: readonly ToolCallRecord[],
) => boolean;
