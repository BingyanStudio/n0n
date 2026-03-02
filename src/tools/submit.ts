/**
 * submit 工具 — agent 提交结果
 *
 * Result<T, E> 模式：result 可以是任意值。
 * 调用方通过 validateResult 判断是否接受。
 * 外部 runtime 通过约定结构判断成功/失败。
 *
 * 当调用方传入 Zod schema 时，`makeSubmitToolDefinition` 会将 JSON Schema
 * 注入到 submit 工具的 `result` 参数描述中，使 LLM 直接看到期望的输出格式。
 */

import type { ZodType } from "zod";
import { toJSONSchema } from "zod";
import type { SubmitToolResult } from "../types/domain.ts";
import type { LLMToolDefinition } from "../types/llm.ts";

interface SubmitArgs {
	result: unknown;
	report?: string;
}

const DEFAULT_DESCRIPTION =
	"Submit your final result. If you completed the task successfully, submit the result value. If you cannot complete the task and need more information, submit an error object like { ok: false, error: 'what went wrong and what you need' }. The caller will review and may provide additional info.";

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
 * 无 schema 时返回默认定义（向后兼容）。
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
