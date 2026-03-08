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
	UntypedToolCall,
} from "@n0n/types";
import { ZodError } from "zod";

/** 工具查找函数类型 — 由 Toolkit 提供 */
export type GetToolEntry = (name: string) => ToolEntry | undefined;

// ── 解析 ──

/**
 * LLM 原始工具调用 → 领域 ToolCallRecord。
 *
 * 解析阶段无法校验参数结构（Zod 校验在执行阶段），
 * 因此统一返回 UnknownToolCall[]；执行器负责 parse + 窄化。
 */
export function parseToolCalls(raw: LLMToolCall[]): UntypedToolCall[] {
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

/** 类型守卫：校验工具名已注册且参数解析成功，窄化为 ToolCallRecord */
export function isValidToolCall(tc: UntypedToolCall): tc is ToolCallRecord {
	return REGISTERED_TOOLS.has(tc.tool) && !("_parseError" in tc.args);
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
