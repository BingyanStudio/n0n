import type { PendingReminder } from "../tools/index.ts";
import {
	execTool,
	reminderTool,
	submitTool,
	TOOL_DEFINITIONS,
	writeTool,
} from "../tools/index.ts";
import type { ToolCallRecord, ToolResult } from "../types/domain.ts";
import type { LLMToolCall } from "../types/llm.ts";

type ToolExecutor = (
	tc: ToolCallRecord,
	reminders: PendingReminder[],
	confirmFn?: (question: string) => Promise<string>,
) => Promise<ToolResult>;

function toToolArgs<T>(args: ToolCallRecord["args"]): T {
	return args as unknown as T;
}

function unknownToolResult(tc: ToolCallRecord): ToolResult {
	return {
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
}

const TOOL_EXECUTORS: Record<string, ToolExecutor> = {
	exec: async (tc, _reminders, confirmFn) =>
		execTool(
			tc.id,
			toToolArgs<Parameters<typeof execTool>[1]>(tc.args),
			confirmFn,
		),
	write: async (tc) =>
		writeTool(tc.id, toToolArgs<Parameters<typeof writeTool>[1]>(tc.args)),
	reminder: async (tc, reminders) =>
		reminderTool(
			tc.id,
			toToolArgs<Parameters<typeof reminderTool>[1]>(tc.args),
			reminders,
		),
	submit: async (tc) =>
		submitTool(tc.id, toToolArgs<Parameters<typeof submitTool>[1]>(tc.args)),
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

export async function executeTool(
	tc: ToolCallRecord,
	reminders: PendingReminder[],
	confirmFn?: (question: string) => Promise<string>,
): Promise<ToolResult> {
	const executor = TOOL_EXECUTORS[tc.tool];
	if (executor) {
		return executor(tc, reminders, confirmFn);
	}

	return unknownToolResult(tc);
}
