/**
 * @n0n/tools — 统一工具注册表
 *
 * 每个工具在此绑定：LLM 定义 + 执行器。
 * 工具参数通过 Zod schema 做运行时校验，消除 as 断言。
 */

import type {
	LLMToolDefinition,
	ToolCallRecord,
	ToolResult,
	ToolStreamEvent,
} from "@n0n/types";
import type { ZodType } from "zod";
import {
	EXEC_TOOL_DEFINITION,
	ExecArgsSchema,
	execToolStream,
} from "./exec.ts";
import {
	type PendingReminder,
	REMINDER_TOOL_DEFINITION,
	ReminderArgsSchema,
	reminderTool,
} from "./reminder.ts";
import {
	makeSubmitToolDefinition,
	SUBMIT_TOOL_DEFINITION,
	SubmitArgsSchema,
	submitTool,
} from "./submit.ts";
import { WRITE_TOOL_DEFINITION, WriteArgsSchema, writeTool } from "./write.ts";

// ── 执行器类型 ──

type StreamExecutor = (
	tc: ToolCallRecord,
	reminders: PendingReminder[],
	confirmFn?: (question: string) => Promise<string>,
) => AsyncGenerator<ToolStreamEvent>;

type SyncExecutor = (
	tc: ToolCallRecord,
	reminders: PendingReminder[],
	confirmFn?: (question: string) => Promise<string>,
) => Promise<ToolResult> | ToolResult;

export type ToolEntry =
	| { definition: LLMToolDefinition; stream: true; execute: StreamExecutor }
	| { definition: LLMToolDefinition; stream: false; execute: SyncExecutor };

// ── 注册表 ──

const TOOL_REGISTRY: Record<string, ToolEntry> = {
	exec: {
		definition: EXEC_TOOL_DEFINITION,
		stream: true,
		execute: (tc, _reminders, confirmFn) =>
			execToolStream(tc.id, ExecArgsSchema.parse(tc.args), confirmFn),
	},
	write: {
		definition: WRITE_TOOL_DEFINITION,
		stream: false,
		execute: (tc) => writeTool(tc.id, WriteArgsSchema.parse(tc.args)),
	},
	reminder: {
		definition: REMINDER_TOOL_DEFINITION,
		stream: false,
		execute: (tc, reminders) =>
			reminderTool(tc.id, ReminderArgsSchema.parse(tc.args), reminders),
	},
	submit: {
		definition: SUBMIT_TOOL_DEFINITION,
		stream: false,
		execute: (tc) => submitTool(tc.id, SubmitArgsSchema.parse(tc.args)),
	},
};

// ── 公共 API ──

export const REGISTERED_TOOLS = new Set(Object.keys(TOOL_REGISTRY));

export function getToolEntry(name: string): ToolEntry | undefined {
	return TOOL_REGISTRY[name];
}

export function makeToolDefinitions(schema?: ZodType): LLMToolDefinition[] {
	return Object.entries(TOOL_REGISTRY).map(([name, entry]) => {
		if (name === "submit" && schema) {
			return makeSubmitToolDefinition(schema);
		}
		return entry.definition;
	});
}

// ── Re-exports ──

export type { ToolsConfig } from "./config.ts";
export { initToolsConfig } from "./config.ts";
export { ENV_INFO } from "./exec.ts";
export type { PendingReminder } from "./reminder.ts";
