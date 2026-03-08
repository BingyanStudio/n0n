/**
 * @n0n/tools — 统一工具注册表
 *
 * 工具集：
 * - write: 文件创建/覆盖
 * - edit: 文件内容修改（search & replace）
 * - exec: 脚本执行（script + runtime）
 * - reminder: 延迟提醒
 * - submit: 提交结果（动态生成）
 *
 * 每个工具在此绑定：LLM 定义 + 执行器。
 * 工具参数通过 Zod schema 做运行时校验。
 */

import type {
	LLMToolDefinition,
	ToolCallRecord,
	ToolResult,
	ToolStreamEvent,
} from "@n0n/types";
import type { ZodType } from "zod";
import { getToolsConfig } from "./config.ts";
import { EDIT_TOOL_DEFINITION, EditArgsSchema, editTool } from "./edit.ts";
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

/** 工具执行的工作区覆盖（用于 per-session 隔离） */
export interface ToolsWorkspaceOverride {
	workspace: string;
	tempDir: string;
}

// ── 基础注册表构建 ──

/**
 * 构建基础工具注册表（不含 submit）。
 * 接受可选的 workspace 覆盖，用于 per-session 工具隔离。
 */
function buildBaseRegistry(
	toolsWorkspace?: ToolsWorkspaceOverride,
): Record<string, ToolEntry> {
	// 统一解析 workspace：优先使用 per-session override，否则使用全局配置
	const resolvedWorkspace =
		toolsWorkspace?.workspace ?? getToolsConfig().workspace;
	const resolvedTempDir = toolsWorkspace?.tempDir ?? getToolsConfig().tempDir;
	const execOverride = toolsWorkspace ?? {
		workspace: resolvedWorkspace,
		tempDir: resolvedTempDir,
	};

	return {
		exec: {
			definition: EXEC_TOOL_DEFINITION,
			stream: true,
			execute: (tc, _reminders, confirmFn) =>
				execToolStream(
					tc.id,
					ExecArgsSchema.parse(tc.args),
					confirmFn,
					execOverride,
				),
		},
		write: {
			definition: WRITE_TOOL_DEFINITION,
			stream: false,
			execute: (tc) =>
				writeTool(tc.id, WriteArgsSchema.parse(tc.args), resolvedWorkspace),
		},
		edit: {
			definition: EDIT_TOOL_DEFINITION,
			stream: false,
			execute: (tc) =>
				editTool(tc.id, EditArgsSchema.parse(tc.args), resolvedWorkspace),
		},
		reminder: {
			definition: REMINDER_TOOL_DEFINITION,
			stream: false,
			execute: (tc, reminders) =>
				reminderTool(tc.id, ReminderArgsSchema.parse(tc.args), reminders),
		},
	};
}

// ── Toolkit ──

export interface Toolkit {
	definitions: LLMToolDefinition[];
	getEntry(name: string): ToolEntry | undefined;
}

export const REGISTERED_TOOLS = new Set([
	"exec",
	"write",
	"edit",
	"reminder",
	"submit",
]);

/**
 * 构建完整的工具集（含 submit）。
 *
 * @param schema 可选的 Zod schema，用于约束 submit 的参数结构。
 * @param toolsWorkspace 可选的工作区覆盖，用于 per-session 隔离。
 */
export function makeToolkit(
	schema?: ZodType,
	toolsWorkspace?: ToolsWorkspaceOverride,
): Toolkit {
	const hasSchema = !!schema;

	const submitEntry: ToolEntry = {
		definition: makeSubmitToolDefinition(schema),
		stream: false,
		execute: (tc) => {
			const args = hasSchema ? tc.args : SubmitArgsSchema.parse(tc.args);
			return submitTool(tc.id, args as Record<string, unknown>, hasSchema);
		},
	};

	const registry: Record<string, ToolEntry> = {
		...buildBaseRegistry(toolsWorkspace),
		submit: submitEntry,
	};

	return {
		definitions: Object.values(registry).map((e) => e.definition),
		getEntry: (name) => registry[name],
	};
}

// ── Re-exports ──

export type { ToolsConfig } from "./config.ts";
export { initToolsConfig } from "./config.ts";
export { getEnvInfo } from "./exec.ts";
export type { PendingReminder } from "./reminder.ts";
