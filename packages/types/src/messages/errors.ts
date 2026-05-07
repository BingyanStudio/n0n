/**
 * 工具错误类型（纯数据，不含提示词）
 */

// ── 工具错误判别联合 ──

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
