/**
 * submit 工具 — 提交 agent 结果
 *
 * ## 设计说明
 *
 * LLM 的 tool call arguments 始终是 JSON 对象（由 API 规范保证）。
 *
 * - **无 schema 时**：参数为 `{ result: unknown, report?: string }`，
 *   result 字段接受任意值。
 * - **有 schema 时**：schema 的属性直接展开到 parameters 顶层，
 *   LLM 直接生成符合 schema 的 JSON 对象（加上可选的 report 字段）。
 *   这样 LLM 能获得每个字段的类型约束，而非只看到一段描述文本。
 */

import type { SubmitToolCall, SubmitToolResult, ToolDefinition } from "@n0n/types";
import type { ZodType } from "zod";
import { toJSONSchema } from "zod";

// ── 无 schema 时的参数校验 ──

export { SubmitArgsSchema } from "@n0n/types";

// ── 工具定义 ──

const DEFAULT_DESCRIPTION =
	"Submit your final result. The parameters ARE the result — fill in the fields directly. Add an optional `report` for notes on what was done.";

type JsonSchema = Record<string, unknown>;

function isJsonSchema(value: unknown): value is JsonSchema {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripFieldDescriptions(schema: unknown): unknown {
	if (Array.isArray(schema)) {
		return schema.map((item) => stripFieldDescriptions(item));
	}
	if (!isJsonSchema(schema)) {
		return schema;
	}

	const next: JsonSchema = {};
	for (const [key, value] of Object.entries(schema)) {
		next[key] =
			key === "description" ? undefined : stripFieldDescriptions(value);
	}
	return next;
}

function flattenVariantProperties(schema: JsonSchema): JsonSchema {
	const properties = isJsonSchema(schema.properties)
		? { ...schema.properties }
		: {};
	const variants = [schema.oneOf, schema.anyOf].flat().filter(isJsonSchema);

	for (const variant of variants) {
		if (!isJsonSchema(variant.properties)) continue;
		for (const [key, value] of Object.entries(variant.properties)) {
			if (properties[key] !== undefined) continue;
			properties[key] = stripFieldDescriptions(value);
		}
	}

	return properties;
}

/* placeholder — will be filled below */
export const SUBMIT_TOOL_DEFINITION: ToolDefinition =
	/* @__PURE__ */ makeSubmitToolDefinition();

/* placeholder end */

/**
 * 根据 Zod schema 生成 submit 工具定义。
 *
 * - 无 schema：保留 `{ result: unknown, report?: string }` 结构。
 * - 有 schema：将 schema 的 JSON Schema 属性展开到 parameters 顶层，
 *   与 report 字段并列。LLM 直接生成符合 schema 的扁平 JSON 对象。
 */
export function makeSubmitToolDefinition(schema?: ZodType): ToolDefinition {
	if (!schema) {
		return {
			name: "submit",
			description: DEFAULT_DESCRIPTION,
			parameters: {
				type: "object",
				properties: {
					result: {
						description:
							"The result value. For success: the requested output. For error: { type: 'error', error: 'description' }.",
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
		};
	}

	// 将 Zod schema 转为 JSON Schema，提取 properties 和 required
	const zodJsonSchema = toJSONSchema(schema) as JsonSchema;
	const schemaProperties = flattenVariantProperties(zodJsonSchema);
	// 从顶层读取 required；若缺失且为 discriminated union，从各 variant 求交集
	let schemaRequired: string[] = Array.isArray(zodJsonSchema.required)
		? [...(zodJsonSchema.required as string[])]
		: [];
	if (schemaRequired.length === 0) {
		const variants = [zodJsonSchema.oneOf, zodJsonSchema.anyOf]
			.flat()
			.filter(isJsonSchema);
		if (variants.length > 0) {
			const variantRequireds = variants
				.map((v) => (Array.isArray(v.required) ? (v.required as string[]) : []))
				.filter((arr) => arr.length > 0);
			if (variantRequireds.length > 0) {
				schemaRequired = variantRequireds.reduce((acc, arr) =>
					acc.filter((key) => arr.includes(key)),
				);
			}
		}
	}

	// 合并：schema 属性 + report 字段
	const mergedProperties: Record<string, unknown> = {
		...schemaProperties,
		report: {
			type: "string",
			description:
				"Optional brief report of what was done and any notable findings.",
		},
	};

	// required 只包含 schema 自身的 required 字段，report 始终可选
	const mergedRequired = [...schemaRequired];

	const schemaStr = JSON.stringify(zodJsonSchema, null, 2);
	const sanitizedProperties = stripFieldDescriptions(
		mergedProperties,
	) as Record<string, unknown>;

	return {
		name: "submit",
		description: `Submit your final result. Fill in the fields directly as parameters — they must conform to this schema:\n\n\`\`\`json\n${schemaStr}\n\`\`\`\n\nValidation is enforced — non-conforming submissions will be rejected.`,
		parameters: {
			type: "object",
			properties: sanitizedProperties,
			required: mergedRequired,
			additionalProperties: false,
		},
	};
}

// ── 执行器 ──

/**
 * 从 submit 工具的 args 中提取结果。
 *
 * - 无 schema 模式：result = args.result
 * - 有 schema 模式：result = args 去掉 report 后的剩余字段
 *
 * @param hasSchema 是否使用了 schema 模式（由调用方传入）
 */
export function extractSubmitResult(
	args: Record<string, unknown>,
	hasSchema: boolean,
): unknown {
	if (!hasSchema) {
		return args.result;
	}
	// schema 模式：去掉 report，剩余就是 result
	const { report: _, ...result } = args;
	return result;
}

export function submitTool(
	call: SubmitToolCall,
	hasSchema: boolean,
): SubmitToolResult {
	return {
		type: "tool_result",
		tool: "submit" as const,
		call,
		cleanedResult: extractSubmitResult(
			call.args as Record<string, unknown>,
			hasSchema,
		),
		userResponse: undefined,
	};
}
