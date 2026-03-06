/**
 * 工具调用解析与执行 — agentLoop 的工具层
 */

import {
	getToolEntry,
	type PendingReminder,
	REGISTERED_TOOLS,
} from "@n0n/tools";
import type { LLMToolCall, ToolCallRecord, ToolStreamEvent } from "@n0n/types";

// ── 解析 ──

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
	return REGISTERED_TOOLS.has(tc.tool) && !tc.args._parseError;
}

// ── 执行 ──

export async function* executeToolStream(
	tc: ToolCallRecord,
	reminders: PendingReminder[],
	confirmFn?: (question: string) => Promise<string>,
): AsyncGenerator<ToolStreamEvent> {
	const entry = getToolEntry(tc.tool);
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
