/**
 * submit 工具 — agent 提交结果
 *
 * Result<T, E> 模式：result 可以是任意值。
 * 调用方通过 validateResult 判断是否接受。
 * 外部 runtime 通过约定结构判断成功/失败。
 */

import type { SubmitToolResult } from "../types/domain.ts";
import type { LLMToolDefinition } from "../types/llm.ts";
import type { ToolPlugin } from "./plugin.ts";

interface SubmitArgs {
	result: unknown;
	report?: string;
}

export const SUBMIT_TOOL_DEFINITION: LLMToolDefinition = {
	type: "function",
	function: {
		name: "submit",
		description:
			"Submit your final result. If you completed the task successfully, submit the result value. If you cannot complete the task and need more information, submit an error object like { ok: false, error: 'what went wrong and what you need' }. The caller will review and may provide additional info.",
		parameters: {
			type: "object",
			properties: {
				result: {
					description:
						"The result value. For success: the requested output. For error: { ok: false, error: string }.",
				},
				report: {
					type: "string",
					description:
						"Optional brief report of what was done and any notable findings.",
				},
			},
			required: ["result"],
			additionalProperties: false,
		},
	},
};

export function submitTool(callId: string, args: SubmitArgs): SubmitToolResult {
	return {
		type: "tool_result",
		callId,
		tool: "submit",
		result: args.result,
		report: args.report ?? null,
	};
}

export const TOOL_PLUGIN: ToolPlugin<SubmitArgs> = {
	definition: SUBMIT_TOOL_DEFINITION,
	execute: (callId, args) => submitTool(callId, args),
};
