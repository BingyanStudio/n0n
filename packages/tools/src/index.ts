/**
 * @n0n/tools — 统一工具注册表
 *
 * 工具集：
 * - write: 文件创建/覆盖
 * - edit: 文件内容修改（影子编辑 — 意图驱动）
 * - exec: 脚本执行（script + runtime）
 * - reminder: 延迟提醒
 * - submit: 提交结果（动态生成）
 *
 * 每个工具使用 ToolDefinition 格式定义 + 自定义执行器绑定。
 * 工具参数通过 Zod schema 做运行时校验。
 */

import type {
	DomainMessage,
	EditToolCall,
	ExecToolCall,
	ReminderToolCall,
	SubmitArgs,
	SubmitToolCall,
	ToolCallRecord,
	ToolDefinition,
	ToolResult,
	ToolStreamEvent,
	WriteToolCall,
} from "@n0n/types";
import type { ZodType } from "zod";
import type { ToolsConfig } from "./config.ts";
import {
	EDIT_TOOL_DEFINITION,
	EditArgsSchema,
	editToolStream,
	StrReplaceBackend,
	FreeformPatchBackend,
} from "./edit/index.ts";
import type { EditBackend } from "./edit/index.ts";
import { detectEnv } from "./env.ts";
import {
	ExecArgsSchema,
	execToolStream,
	makeExecToolDefinition,
} from "./exec/index.ts";
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
import {
	makeWriteRecover,
	WRITE_TOOL_DEFINITION,
	WriteArgsSchema,
	writeTool,
} from "./write.ts";

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

/** 截断恢复结果：恢复后的工具调用 + 执行结果 */
export interface RecoverResult {
	call: ToolCallRecord;
	result: DomainMessage;
}

/**
 * 截断恢复+执行函数：尝试从不完整的 JSON 参数中恢复并执行，返回 call+result 对。
 *
 * 始终为非流式（返回 Promise），与 execute 的 stream 模式无关。原因：
 * 截断恢复的结果不经过 scheduler/renderBuffer 流式管线，
 * 而是由 tool-recovery 模块直接产出 (call, result) 对追加到 history。
 * 截断场景下参数不完整，不适合做正常的流式执行。
 */
export type RecoverFn = (
	toolCallId: string,
	partialJson: string,
) => Promise<RecoverResult | null>;

/** 工具注册表条目 — stream 字段决定 execute 类型，recoverAndExecute 与 stream 无关 */
export type ToolEntry = {
	definition: ToolDefinition;
	recoverAndExecute?: RecoverFn;
} & (
	| { stream: true; execute: StreamExecutor }
	| { stream: false; execute: SyncExecutor }
);

// ── 基础注册表构建 ──

/**
 * 构建基础工具注册表（不含 submit）。
 * 接受完整的 ToolsConfig（含 security/agent/workspace/tempDir/editorClient）。
 */
function buildBaseRegistry(
	execToolDef: ToolDefinition,
	toolsConfig: ToolsConfig,
): Record<string, ToolEntry> {
	const resolvedWorkspace = toolsConfig.workspace;
	const execConfig = {
		workspace: toolsConfig.workspace,
		tempDir: toolsConfig.tempDir,
		blockedCommands: toolsConfig.security.blockedCommands,
		defaultExecTimeout: toolsConfig.agent.defaultExecTimeout,
	};

	const editBackend: EditBackend =
		toolsConfig.editBackendType === "freeform-patch"
			? new FreeformPatchBackend(toolsConfig.responsesClient)
			: new StrReplaceBackend(toolsConfig.editorClient);

	return {
		exec: {
			definition: execToolDef,
			stream: true,
			execute: (tc, _reminders, confirmFn) => {
				const call: ExecToolCall = {
					id: tc.id,
					tool: "exec" as const,
					args: ExecArgsSchema.parse(tc.args),
				};
				return execToolStream(call, confirmFn, execConfig);
			},
		},
		write: {
			definition: WRITE_TOOL_DEFINITION,
			stream: false,
			execute: (tc) => {
				const call: WriteToolCall = {
					id: tc.id,
					tool: "write" as const,
					args: WriteArgsSchema.parse(tc.args),
				};
				return writeTool(call, resolvedWorkspace);
			},
			recoverAndExecute: makeWriteRecover(resolvedWorkspace),
		},
		edit: {
			definition: EDIT_TOOL_DEFINITION,
			stream: true,
			execute: (tc) => {
				const call: EditToolCall = {
					id: tc.id,
					tool: "edit" as const,
					args: EditArgsSchema.parse(tc.args),
				};
				return editToolStream(
					call,
					resolvedWorkspace,
					editBackend,
				);
			},
		},
		reminder: {
			definition: REMINDER_TOOL_DEFINITION,
			stream: false,
			execute: (tc, reminders) => {
				const call: ReminderToolCall = {
					id: tc.id,
					tool: "reminder" as const,
					args: ReminderArgsSchema.parse(tc.args),
				};
				return reminderTool(call, reminders);
			},
		},
	};
}

// ── Toolkit ──

export interface Toolkit {
	/** ToolDefinition 列表 — 供 client.stream() 使用 */
	tools: ToolDefinition[];
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
 * 异步：首次调用会探测系统可用 runtime（~1-2s），后续调用使用缓存。
 *
 * @param schema 可选的 Zod schema，用于约束 submit 的参数结构。
 * @param toolsConfig 工具配置，包含 workspace、tempDir、security、editorClient 等。
 * @param model LLM 模型名称，用于选择 XML tag 风格（可选）。
 */
export async function makeToolkit(
	schema: ZodType | undefined,
	toolsConfig: ToolsConfig,
	model?: string,
): Promise<Toolkit> {
	const env = await detectEnv();
	const execToolDef = makeExecToolDefinition(env, model);
	const hasSchema = !!schema;

	const submitEntry: ToolEntry = {
		definition: makeSubmitToolDefinition(schema),
		stream: false,
		execute: (tc) => {
			const parsedArgs = hasSchema ? tc.args : SubmitArgsSchema.parse(tc.args);
			const call: SubmitToolCall = {
				id: tc.id,
				tool: "submit" as const,
				args: parsedArgs as SubmitArgs,
			};
			return submitTool(call, hasSchema);
		},
	};

	const registry: Record<string, ToolEntry> = {
		...buildBaseRegistry(execToolDef, toolsConfig),
		submit: submitEntry,
	};

	// 从注册表构建 ToolDefinition 列表
	const tools = Object.values(registry).map((entry) => entry.definition);

	return {
		tools,
		getEntry: (name) => registry[name],
	};
}

// ── Re-exports ──

export type { ToolsConfig, ResponsesClient } from "./config.ts";
export type { EnvSnapshot, RuntimeProbe } from "./env.ts";
export { detectEnv, getCachedEnv } from "./env.ts";
export type { PendingReminder } from "./reminder.ts";
