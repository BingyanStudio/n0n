/**
 * submit 工具 — agent 提交结果
 *
 * Result<T, E> 模式：result 可以是任意值。
 * 调用方通过 validateResult 判断是否接受。
 * 外部 runtime 通过约定结构判断成功/失败。
 */

import type { SubmitToolResult } from "../types/domain.ts";

interface SubmitArgs {
	result: unknown;
	report?: string;
}

export function submitTool(callId: string, args: SubmitArgs): SubmitToolResult {
	return {
		type: "tool_result",
		callId,
		tool: "submit",
		result: args.result,
		report: args.report ?? null,
	};
}
