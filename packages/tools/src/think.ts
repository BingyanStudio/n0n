/**
 * think 工具 — 工具调用间的思考检查点
 *
 * 模型在一次响应中发出多个工具调用时，穿插调用 think 来审视
 * 是否还有可以在当前响应中一并发出的操作，然后继续生成更多调用。
 *
 * 排在工具列表第一位，为模型提供"多次调用"的信号。
 */

import type {
	ThinkToolCall,
	ThinkToolResult,
	ToolDefinition,
} from "@n0n/types";

export { ThinkArgsSchema } from "@n0n/types";

export const THINK_TOOL_DEFINITION: ToolDefinition = {
	name: "think",
	description: [
		"Use this tool to think between tool calls. In `content`, review what other operations you can issue in the current response.",
		"",
		"write and edit always succeed — treat their results as available immediately.",
		"After calling them, call think to decide what to do next, then issue those calls — all in the same response.",
		"Only stop and wait when you genuinely need a tool's output (e.g. exec) to decide what to do next.",
	].join("\n"),
	parameters: {
		type: "object",
		properties: {
			content: {
				type: "string",
				description:
					"Your thinking: what other operations can you issue now that don't depend on pending results?",
			},
		},
		required: ["content"],
		additionalProperties: false,
	},
};

export function thinkTool(call: ThinkToolCall): ThinkToolResult {
	return {
		type: "tool_result",
		tool: "think" as const,
		call,
		acknowledged: true,
	};
}
