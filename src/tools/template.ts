import type { GenericToolResult } from "../types/domain.ts";
import type { LLMToolDefinition } from "../types/llm.ts";
import type { ToolPlugin } from "./plugin.ts";

interface TemplateArgs {
	input: string;
}

export const TEMPLATE_TOOL_DEFINITION: LLMToolDefinition = {
	type: "function",
	function: {
		name: "your_tool_name",
		description: "Describe what this tool does.",
		parameters: {
			type: "object",
			properties: {
				input: {
					type: "string",
					description: "Main input for this tool",
				},
			},
			required: ["input"],
			additionalProperties: false,
		},
	},
};

async function templateTool(
	callId: string,
	args: TemplateArgs,
): Promise<GenericToolResult> {
	return {
		type: "tool_result",
		callId,
		tool: "your_tool_name",
		ok: true,
		result: args.input,
	};
}

export const TEMPLATE_TOOL_PLUGIN: ToolPlugin<TemplateArgs> = {
	definition: TEMPLATE_TOOL_DEFINITION,
	execute: (callId, args) => templateTool(callId, args),
};
