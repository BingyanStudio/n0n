/**
 * submit 工具 — agent 提交结果
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
