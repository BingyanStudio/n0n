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

import type { LLMToolDefinition, SubmitToolResult } from "@n0n/types";
import type { ZodType } from "zod";
import { toJSONSchema, z } from "zod";

// ── 无 schema 时的参数校验 ──

/** submit 工具参数 schema（无 schema 模式）— 运行时校验 LLM 传入的参数 */
export const SubmitArgsSchema = z.object({
	result: z.unknown(),
	report: z.string().optional(),
});

export type SubmitArgs = z.infer<typeof SubmitArgsSchema>;

// ── 工具定义 ──

const DEFAULT_DESCRIPTION =
	"Submit your final result. The parameters ARE the result — fill in the fields directly. Add an optional `report` for notes on what was done.";

/* placeholder — will be filled below */
export const SUBMIT_TOOL_DEFINITION: LLMToolDefinition =
	/* @__PURE__ */ makeSubmitToolDefinition();

/* placeholder end */

/**
 * 根据 Zod schema 生成 submit 工具定义。
 *
 * - 无 schema：保留 `{ result: unknown, report?: string }` 结构。
 * - 有 schema：将 schema 的 JSON Schema 属性展开到 parameters 顶层，
 *   与 report 字段并列。LLM 直接生成符合 schema 的扁平 JSON 对象。
 */
export function makeSubmitToolDefinition(schema?: ZodType): LLMToolDefinition {
	if (!schema) {
		return {
			type: "function",
			function: {
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
			},
		};
	}

	// 将 Zod schema 转为 JSON Schema，提取 properties 和 required
	const jsonSchema = toJSONSchema(schema) as Record<string, unknown>;
	const { properties: schemaProperties, required: schemaRequired } =
		flattenJsonSchema(jsonSchema);

	// 合并：schema 属性 + report 字段
	const mergedProperties: Record<string, unknown> = {
		...schemaProperties,
		report: {
			type: "string",
			description:
				"Optional brief report of what was done and any notable findings.",
		},
	};

	// required 只包含所有分支共有的 required 字段，report 始终可选
	const mergedRequired = [...schemaRequired];

	const schemaStr = JSON.stringify(jsonSchema, null, 2);

	return {
		type: "function",
		function: {
			name: "submit",
			description: `Submit your final result. Fill in the fields directly as parameters — they must conform to this schema:\n\n\`\`\`json\n${schemaStr}\n\`\`\`\n\nValidation is enforced — non-conforming submissions will be rejected.`,
			parameters: {
				type: "object",
				properties: mergedProperties,
				required: mergedRequired,
				additionalProperties: false,
			},
		},
	};
}

// ── JSON Schema 扁平化 ──

interface FlatSchema {
	properties: Record<string, unknown>;
	required: string[];
}

/**
 * 将 JSON Schema 扁平化为单一 object 的 properties + required。
 *
 * - 普通 object schema：直接提取 properties/required。
 * - oneOf/anyOf（discriminatedUnion 等）：合并所有分支的 properties，
 *   只有所有分支都 require 的字段才标记为 required。
 *   这样 LLM 能看到所有可能的字段，Zod 在应用层做精确校验。
 */
function flattenJsonSchema(schema: Record<string, unknown>): FlatSchema {
	// 普通 object — 直接提取
	if (schema.properties) {
		return {
			properties: schema.properties as Record<string, unknown>,
			required: (schema.required as string[]) ?? [],
		};
	}

	// oneOf / anyOf — 合并所有分支
	const branches = (schema.oneOf ?? schema.anyOf) as
		| Record<string, unknown>[]
		| undefined;
	if (!branches || branches.length === 0) {
		return { properties: {}, required: [] };
	}

	const merged: Record<string, unknown> = {};
	const requiredSets: Set<string>[] = [];

	// 收集每个字段在各分支中的定义，用于合并 const → enum
	const fieldDefs = new Map<string, Record<string, unknown>[]>();

	for (const branch of branches) {
		const props = (branch.properties ?? {}) as Record<string, unknown>;
		const req = new Set((branch.required as string[]) ?? []);
		for (const [key, value] of Object.entries(props)) {
			const existing = fieldDefs.get(key);
			if (existing) {
				existing.push(value as Record<string, unknown>);
			} else {
				fieldDefs.set(key, [value as Record<string, unknown>]);
			}
		}
		requiredSets.push(req);
	}

	for (const [key, defs] of fieldDefs) {
		const first = defs[0];
		if (!first) continue;
		// 多个分支都有 const 值的字段（如 discriminator "type"）→ 合并为 enum
		const constValues = defs
			.filter((d) => "const" in d)
			.map((d) => d.const as string);
		if (constValues.length > 1) {
			const base = { ...first };
			delete base.const;
			base.enum = constValues;
			merged[key] = base;
		} else {
			merged[key] = first;
		}
	}

	// 只有所有分支都 require 的字段才是全局 required
	const firstReqSet = requiredSets[0];
	const globalRequired = firstReqSet
		? [...firstReqSet].filter((key) => requiredSets.every((s) => s.has(key)))
		: [];

	return { properties: merged, required: globalRequired };
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
	callId: string,
	args: Record<string, unknown>,
	hasSchema: boolean,
): SubmitToolResult {
	const report = typeof args.report === "string" ? args.report : null;
	return {
		type: "tool_result",
		callId,
		tool: "submit",
		result: extractSubmitResult(args, hasSchema),
		report,
	};
}
