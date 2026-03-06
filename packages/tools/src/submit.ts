/**
 * submit 工具 — 提交 agent 结果
 */

import type { LLMToolDefinition, SubmitToolResult } from "@n0n/types";
import type { ZodType } from "zod";
import { toJSONSchema, z } from "zod";

/** submit 工具参数 schema — 运行时校验 LLM 传入的参数 */
export const SubmitArgsSchema = z.object({
	result: z.unknown(),
	report: z.string().optional(),
});

export type SubmitArgs = z.infer<typeof SubmitArgsSchema>;

const DEFAULT_DESCRIPTION =
	"Submit your final result. Use { type: 'completed', result: '...' } for success, or { type: 'error', error: 'what went wrong and what you need' }. The caller will review and may provide additional info.";

const DEFAULT_RESULT_DESCRIPTION =
	"The result value. For success: the requested output. For error: { ok: false, error: string }.";

export const SUBMIT_TOOL_DEFINITION: LLMToolDefinition = {
	type: "function",
	function: {
		name: "submit",
		description: DEFAULT_DESCRIPTION,
		parameters: {
			type: "object",
			properties: {
				result: {
					description: DEFAULT_RESULT_DESCRIPTION,
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

/**
 * 根据 Zod schema 生成带有 JSON Schema 约束的 submit 工具定义。
 */
export function makeSubmitToolDefinition(schema?: ZodType): LLMToolDefinition {
	if (!schema) return SUBMIT_TOOL_DEFINITION;

	const jsonSchema = toJSONSchema(schema);
	const schemaStr = JSON.stringify(jsonSchema, null, 2);

	return {
		type: "function",
		function: {
			name: "submit",
			description: `Submit your final result. The \`result\` field MUST conform to the following JSON Schema:\n\n\`\`\`json\n${schemaStr}\n\`\`\`\n\nValidation is enforced — non-conforming submissions will be rejected.`,
			parameters: {
				type: "object",
				properties: {
					result: {
						description: `The result value. MUST match this JSON Schema:\n${schemaStr}`,
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
