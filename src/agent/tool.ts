import type { PendingReminder } from "../tools/index.ts";
import {
	execToolStream,
	reminderTool,
	submitTool,
	TOOL_DEFINITIONS,
	writeTool,
} from "../tools/index.ts";
import type {
	ToolCallRecord,
	ToolResult,
	ToolStreamEvent,
} from "../types/domain.ts";
import type { LLMToolCall } from "../types/llm.ts";

// ── 工具执行器类型 ──

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

type ToolExecutorEntry =
	| { stream: true; execute: StreamExecutor }
	| { stream: false; execute: SyncExecutor };

function toToolArgs<T>(args: ToolCallRecord["args"]): T {
	return args as unknown as T;
}

// ── 工具注册表 ──

const TOOL_EXECUTORS: Record<string, ToolExecutorEntry> = {
	exec: {
		stream: true,
		execute: (tc, _reminders, confirmFn) =>
			execToolStream(
				tc.id,
				toToolArgs<Parameters<typeof execToolStream>[1]>(tc.args),
				confirmFn,
			),
	},
	write: {
		stream: false,
		execute: (tc) =>
			writeTool(tc.id, toToolArgs<Parameters<typeof writeTool>[1]>(tc.args)),
	},
	reminder: {
		stream: false,
		execute: (tc, reminders) =>
			reminderTool(
				tc.id,
				toToolArgs<Parameters<typeof reminderTool>[1]>(tc.args),
				reminders,
			),
	},
	submit: {
		stream: false,
		execute: (tc) =>
			submitTool(tc.id, toToolArgs<Parameters<typeof submitTool>[1]>(tc.args)),
	},
};

const DEFINED_TOOLS = new Set(TOOL_DEFINITIONS.map((t) => t.function.name));

function assertToolRegistryConsistency(): void {
	const executable = new Set(Object.keys(TOOL_EXECUTORS));

	const missingExecutor = [...DEFINED_TOOLS].filter(
		(name) => !executable.has(name),
	);
	const missingDefinition = [...executable].filter(
		(name) => !DEFINED_TOOLS.has(name),
	);

	if (missingExecutor.length === 0 && missingDefinition.length === 0) {
		return;
	}

	const details = [
		missingExecutor.length
			? `missing executor(s): ${missingExecutor.join(", ")}`
			: null,
		missingDefinition.length
			? `missing definition(s): ${missingDefinition.join(", ")}`
			: null,
	]
		.filter(Boolean)
		.join("; ");

	throw new Error(`Tool registry mismatch: ${details}`);
}

assertToolRegistryConsistency();

// ── 解析 + 校验 ──

export function parseToolCalls(raw: LLMToolCall[]): ToolCallRecord[] {
	return raw.map((tc) => {
		let args: Record<string, unknown>;
		try {
			const parsed =
				typeof tc.function.arguments === "string"
					? JSON.parse(tc.function.arguments)
					: tc.function.arguments;
			args = parsed as Record<string, unknown>;
		} catch {
			args = { _parseError: true, _raw: tc.function.arguments };
		}
		return {
			id: tc.id,
			tool: tc.function.name,
			args,
		};
	});
}

export function isValidToolCall(tc: ToolCallRecord): boolean {
	return DEFINED_TOOLS.has(tc.tool) && !tc.args._parseError;
}

// ── 统一流式执行入口 ──

/**
 * 执行工具，统一返回 AsyncGenerator<ToolStreamEvent>。
 * 流式工具（exec）直接 yield chunk + result；
 * 同步工具包装为只 yield 一个 result 的 generator。
 */
export async function* executeToolStream(
	tc: ToolCallRecord,
	reminders: PendingReminder[],
	confirmFn?: (question: string) => Promise<string>,
): AsyncGenerator<ToolStreamEvent> {
	const entry = TOOL_EXECUTORS[tc.tool];
	if (!entry) {
		yield {
			type: "tool_result",
			callId: tc.id,
			tool: "exec",
			command: "",
			cwd: "",
			exitCode: 1,
			stdout: "",
			stderr: `Unknown tool: ${tc.tool}`,
			durationMs: 0,
		};
		return;
	}

	if (entry.stream) {
		yield* entry.execute(tc, reminders, confirmFn);
	} else {
		yield await entry.execute(tc, reminders, confirmFn);
	}
}
