/**
 * submit 工具 — 提交 agent 结果
 *
 * ## 设计说明
 *
 * 所有模式统一走 schema 路径：
 * - 有自定义 schema 时：使用调用方提供的 schema。
 * - 无自定义 schema 时：使用默认 schema `{ report: string }`。
 *
 * parameters 不约束具体字段（接受任意 object），
 * 完整的 JSON Schema 放在 description 中供模型参考，
 * 后端用 zod schema 做后验证。
 */

import type {
	SubmitToolCall,
	SubmitToolResult,
	ToolDefinition,
} from "@n0n/types";
import { toJSONSchema, type ZodType, z } from "zod";

// ── 默认 schema（无自定义 schema 时使用） ──

export const DefaultSubmitSchema = z.object({
	report: z
		.string()
		.describe("Brief report of what was done and any notable findings."),
});

// ── 工具定义 ──

export const SUBMIT_TOOL_DEFINITION: ToolDefinition =
	/* @__PURE__ */ makeSubmitToolDefinition();

/**
 * 根据 Zod schema 生成 submit 工具定义。
 *
 * 无论是否传入自定义 schema，都走同一条路径：
 * parameters 为开放的 object，完整 JSON Schema 写入 description。
 */
export function makeSubmitToolDefinition(schema?: ZodType): ToolDefinition {
	const effectiveSchema = schema ?? DefaultSubmitSchema;
	const schemaStr = JSON.stringify(toJSONSchema(effectiveSchema), null, 2);

	return {
		name: "submit",
		description: `Submit your final result. Fill in the fields directly as parameters — they must conform to this schema:\n\n\`\`\`json\n${schemaStr}\n\`\`\`\n\nValidation is enforced — non-conforming submissions will be rejected.`,
		parameters: {
			type: "object",
		},
	};
}

// ── 执行器 ──

export function submitTool(call: SubmitToolCall): SubmitToolResult {
	return {
		type: "tool_result",
		tool: "submit" as const,
		call,
		cleanedResult: call.args,
		userResponse: undefined,
	};
}
