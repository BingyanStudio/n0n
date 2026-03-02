/**
 * 统一工具注册表 — 单一数据源
 *
 * 每个工具在此绑定：LLM 定义 + 执行器。
 * 加新工具只需在 TOOL_REGISTRY 中添加一条。
 */

import type { ZodType } from "zod";
import type {
	ToolCallRecord,
	ToolResult,
	ToolStreamEvent,
} from "../types/domain.ts";
import type { LLMToolDefinition } from "../types/llm.ts";
import { ENV_INFO, EXEC_TOOL_DEFINITION, execToolStream } from "./exec.ts";
import {
	REMINDER_TOOL_DEFINITION,
	reminderTool,
	type PendingReminder,
} from "./reminder.ts";
import {
	SUBMIT_TOOL_DEFINITION,
	makeSubmitToolDefinition,
	submitTool,
} from "./submit.ts";
import { WRITE_TOOL_DEFINITION, writeTool } from "./write.ts";

// ── 执行器类型 ──

/** 流式执行器：yield chunk + 最终 result */
type StreamExecutor = (
	tc: ToolCallRecord,
	reminders: PendingReminder[],
	confirmFn?: (question: string) => Promise<string>,
) => AsyncGenerator<ToolStreamEvent>;

/** 同步执行器：直接返回 result */
type SyncExecutor = (
	tc: ToolCallRecord,
	reminders: PendingReminder[],
	confirmFn?: (question: string) => Promise<string>,
) => Promise<ToolResult> | ToolResult;

/** 工具注册单元：定义 + 执行器绑定 */
export type ToolEntry =
	| { definition: LLMToolDefinition; stream: true; execute: StreamExecutor }
	| { definition: LLMToolDefinition; stream: false; execute: SyncExecutor };

// ── 辅助：参数强转（MVP，后续 R6 会加 Zod 校验） ──

function toArgs<T>(args: ToolCallRecord["args"]): T {
	return args as unknown as T;
}

// ── 注册表 ──

const TOOL_REGISTRY: Record<string, ToolEntry> = {
	exec: {
		definition: EXEC_TOOL_DEFINITION,
		stream: true,
		execute: (tc, _reminders, confirmFn) =>
			execToolStream(
				tc.id,
				toArgs<Parameters<typeof execToolStream>[1]>(tc.args),
				confirmFn,
			),
	},
	write: {
		definition: WRITE_TOOL_DEFINITION,
		stream: false,
		execute: (tc) =>
			writeTool(tc.id, toArgs<Parameters<typeof writeTool>[1]>(tc.args)),
	},
	reminder: {
		definition: REMINDER_TOOL_DEFINITION,
		stream: false,
		execute: (tc, reminders) =>
			reminderTool(
				tc.id,
				toArgs<Parameters<typeof reminderTool>[1]>(tc.args),
				reminders,
			),
	},
	submit: {
		definition: SUBMIT_TOOL_DEFINITION,
		stream: false,
		execute: (tc) =>
			submitTool(tc.id, toArgs<Parameters<typeof submitTool>[1]>(tc.args)),
	},
};

// ── 公共 API ──

/** 已注册的工具名集合 */
export const REGISTERED_TOOLS = new Set(Object.keys(TOOL_REGISTRY));

/** 查找工具条目 */
export function getToolEntry(name: string): ToolEntry | undefined {
	return TOOL_REGISTRY[name];
}

/**
 * 生成 LLM 工具定义列表。
 * 有 schema 时，submit 工具描述注入 JSON Schema 约束。
 */
export function makeToolDefinitions(schema?: ZodType): LLMToolDefinition[] {
	return Object.entries(TOOL_REGISTRY).map(([name, entry]) => {
		if (name === "submit" && schema) {
			return makeSubmitToolDefinition(schema);
		}
		return entry.definition;
	});
}

// ── Re-exports（供外部直接使用的工具函数和类型） ──

export { ENV_INFO } from "./exec.ts";
export type { PendingReminder } from "./reminder.ts";
