/**
 * 工具类型注册表 — SSoT
 *
 * ToolMap 定义了所有工具名到参数类型的映射。
 * MakeCall / MakeResult 辅助类型消除具体定义中的样板代码。
 */

import type {
	EditArgs,
	ExecArgs,
	ProgressArgs,
	WriteArgs,
} from "../../tool-args.ts";

// ── 核心注册表 ──

export interface ToolMap {
	exec: ExecArgs;
	write: WriteArgs;
	edit: EditArgs;
	progress: ProgressArgs;
}

export type ToolName = keyof ToolMap;

// ── 辅助类型 ──

/** 构造特定工具的 Call 类型 */
export type MakeCall<T extends ToolName> = {
	id: string;
	tool: T;
	args: ToolMap[T];
};

/** 构造特定工具的 Result 基类 */
export type MakeResult<T extends ToolName, S extends string> = {
	type: "tool_result";
	tool: T;
	call: MakeCall<T>;
	status: S;
};

/** 构造特定工具的 Result 基类（无 status 判别字段） */
export type MakeResultBase<T extends ToolName> = {
	type: "tool_result";
	tool: T;
	call: MakeCall<T>;
};

// ── 导出联合类型 ──

/**
 * 工具调用记录 — 判别联合，通过 tool 字段窄化 args 类型。
 * 参数类型来自 tool-args.ts 中的 Zod schema（z.infer），
 * 修改 schema 字段时 tsc 会在所有消费方报错。
 */
export type ToolCallRecord = {
	[K in ToolName]: MakeCall<K>;
}[ToolName];

export type ToolCallRecordMap = {
	[K in ToolName]: Extract<ToolCallRecord, { tool: K }>;
};

// 快捷导出
export type ExecToolCall = ToolCallRecordMap["exec"];
export type WriteToolCall = ToolCallRecordMap["write"];
export type EditToolCall = ToolCallRecordMap["edit"];
export type ProgressToolCall = ToolCallRecordMap["progress"];

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
