import {
    executeRegisteredTool,
    hasRegisteredTool,
} from "../tools/index.ts";
import type { PendingReminder } from "../tools/plugin.ts";
import type { ToolCallRecord, ToolResult } from "../types/domain.ts";
import type { LLMToolCall } from "../types/llm.ts";

function unknownToolResult(tc: ToolCallRecord): ToolResult {
	return {
		type: "tool_result",
		callId: tc.id,
		tool: tc.tool,
		error: `Unknown tool: ${tc.tool}`,
	};
}

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
	return hasRegisteredTool(tc.tool) && !tc.args._parseError;
}

export async function executeTool(
	tc: ToolCallRecord,
	reminders: PendingReminder[],
	confirmFn?: (question: string) => Promise<string>,
): Promise<ToolResult> {
	if (hasRegisteredTool(tc.tool)) {
		return executeRegisteredTool(tc, reminders, confirmFn);
	}

	return unknownToolResult(tc);
}
