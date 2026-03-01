import type { ToolCallRecord, ToolResult } from "../types/domain.ts";
import type { LLMToolDefinition } from "../types/llm.ts";

export interface PendingReminder {
	content: string;
	roundsLeft: number;
}

export interface ToolExecutionContext {
	reminders: PendingReminder[];
	confirmFn?: (question: string) => Promise<string>;
}

export interface ToolPlugin<TArgs = Record<string, unknown>> {
	definition: LLMToolDefinition;
	execute: (
		callId: string,
		args: TArgs,
		context: ToolExecutionContext,
	) => Promise<ToolResult> | ToolResult;
}

export function toToolArgs<T>(args: ToolCallRecord["args"]): T {
	return args as unknown as T;
}
