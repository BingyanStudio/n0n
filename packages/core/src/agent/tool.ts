/**
 * 工具调用解析与执行 — agentLoop 的工具层
 */

import {
	type PendingReminder,
	REGISTERED_TOOLS,
	type ToolEntry,
} from "@n0n/tools";
import type {
	LLMToolCall,
	ToolArgErrorMessage,
	ToolCallRecord,
	ToolStreamEvent,
} from "@n0n/types";
import { ZodError } from "zod";

/** 工具查找函数类型 — 由 Toolkit 提供 */
export type GetToolEntry = (name: string) => ToolEntry | undefined;

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
	getEntry?: GetToolEntry,
): AsyncGenerator<ToolStreamEvent> {
	const resolve = getEntry ?? ((_name: string) => undefined);
	const entry = resolve(tc.tool);
	if (!entry) {
		yield {
			type: "tool_result",
			callId: tc.id,
			tool: "exec",
			script: "",
			runtime: "",
			cwd: "",
			exitCode: 1,
			stdout: "",
			stderr: `Unknown tool: ${tc.tool}`,
			durationMs: 0,
		};
		return;
	}

	try {
		if (entry.stream) {
			yield* entry.execute(tc, reminders, confirmFn);
		} else {
			yield await entry.execute(tc, reminders, confirmFn);
		}
	} catch (err) {
		if (err instanceof ZodError) {
			const argError: ToolArgErrorMessage = {
				type: "tool_arg_error",
				callId: tc.id,
				tool: tc.tool,
				error: err.issues
					.map((i) => `${i.path.join(".")}: ${i.message}`)
					.join("; "),
				schema:
					(entry.definition.function.parameters as unknown as Record<
						string,
						unknown
					>) ?? {},
			};
			yield argError;
			return;
		}
		throw err;
	}
}
