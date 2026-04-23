/**
 * Zod schema → ToolDefinition["parameters"] 转换
 *
 * 从 Zod schema 自动生成 JSON Schema 格式的工具参数定义。
 * FieldDescriptions<T> 强制要求为 schema 的每个字段提供描述，
 * schema 新增字段时未同步描述 → tsc 报错。
 */

import type { ToolDefinition } from "@n0n/types";
import { type z, toJSONSchema } from "zod";

/**
 * 强制覆盖 schema 所有字段的描述映射。
 * schema 新增/删除字段时，此类型自动要求同步更新。
 */
export type FieldDescriptions<T> = { [K in keyof Required<T>]: string };

/**
 * 将 Zod object schema + 字段描述 → ToolDefinition["parameters"]。
 *
 * @param schema 基础 Zod schema（来自 @n0n/types）
 * @param descriptions 每个字段的 LLM 可见描述（类型强制覆盖所有字段）
 */
export function zodToParameters<S extends z.ZodObject>(
	schema: S,
	descriptions: FieldDescriptions<z.infer<S>>,
): ToolDefinition["parameters"] {
	const extensions: Record<string, z.ZodType> = {};
	for (const [key, desc] of Object.entries(descriptions)) {
		extensions[key] = (schema.shape[key] as z.ZodType).describe(desc as string);
	}
	const described = schema.extend(extensions);
	const js = toJSONSchema(described);
	// 从 toJSONSchema 宽泛返回类型中精确提取 ToolDefinition["parameters"] 需要的字段
	return {
		type: "object",
		properties: js.properties as Record<string, unknown>,
		required: js.required as string[],
		additionalProperties: false,
	} satisfies ToolDefinition["parameters"];
}
