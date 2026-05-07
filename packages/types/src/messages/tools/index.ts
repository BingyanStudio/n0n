/**
 * 工具类型聚合模块
 */

// 注册表核心
export type {
	ToolMap,
	ToolName,
	MakeCall,
	MakeResult,
	MakeResultBase,
	ToolCallRecord,
	ToolCallRecordMap,
	ExecToolCall,
	WriteToolCall,
	EditToolCall,
	ProgressToolCall,
	PartialToolCallRecord,
} from "./registry.ts";

// Exec
export type { ExecCompleted, ExecTruncated, ExecBackgrounded, ExecToolResult } from "./exec.ts";

// Write
export type {
	WriteCompleted,
	WriteFailed,
	WriteRecovered,
	WriteRecoverFailed,
	WriteToolResult,
} from "./write.ts";

// Edit
export type { PatchOp, EditToolResult } from "./edit.ts";

// Progress
export type { ProgressToolResult } from "./progress.ts";

// ── 聚合 ToolResult 联合 ──

import type { ExecToolResult } from "./exec.ts";
import type { WriteToolResult } from "./write.ts";
import type { EditToolResult } from "./edit.ts";
import type { ProgressToolResult } from "./progress.ts";

export type ToolResult =
	| ExecToolResult
	| WriteToolResult
	| EditToolResult
	| ProgressToolResult;

// ── 工具执行结局 ──

import type { ToolArgErrorMessage } from "../errors.ts";

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
