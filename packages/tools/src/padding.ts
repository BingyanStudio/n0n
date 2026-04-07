/**
 * padding 工具 — 工具调用检查点
 *
 * 模型在调用完其他工具后调用此工具，在 think 参数中审视当前轮次
 * 是否还有可以一并发出的操作。类似铁路指差确认——价值在于强制执行
 * 检查这个动作本身。
 *
 * 排在工具列表第一位，为模型提供"多次调用"的信号。
 */

import type {
	PaddingToolCall,
	PaddingToolResult,
	ToolDefinition,
} from "@n0n/types";

export { PaddingArgsSchema } from "@n0n/types";

export const PADDING_TOOL_DEFINITION: ToolDefinition = {
	name: "padding",
	description: [
		"Call this after your other tool calls. In `think`, review what else you can do without waiting for pending results.",
		"",
		"write and edit always succeed — treat them as done immediately.",
		"After calling them, use padding to plan your next operations, then issue those calls in the same response.",
		"Only wait when you genuinely need a tool's output (e.g. exec) to decide what to do next.",
	].join("\n"),
	parameters: {
		type: "object",
		properties: {
			think: {
				type: "string",
				description:
					"Review this turn: what other operations can you issue now that don't depend on pending results?",
			},
		},
		required: ["think"],
		additionalProperties: false,
	},
};

export function paddingTool(call: PaddingToolCall): PaddingToolResult {
	return {
		type: "tool_result",
		tool: "padding" as const,
		call,
		acknowledged: true,
	};
}
