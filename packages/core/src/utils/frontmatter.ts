/**
 * Frontmatter 解析工具 — 统一的 YAML frontmatter 解析
 *
 * 支持两种模式：
 * 1. 无 schema：返回 Record<string, string>（向后兼容）
 * 2. 有 schema：通过 Zod 校验，返回强类型结果或 null
 *
 * 供 skill discovery 和 scheduler 共享。
 */

import type { ZodType } from "zod";

// ── 类型 ──

export interface RawFrontmatter {
	/** 顶层 key-value 对（全部为 string） */
	meta: Record<string, string>;
	/** frontmatter 之后的正文 */
	body: string;
}

export interface TypedFrontmatter<T> {
	/** 经过 schema 校验的强类型数据 */
	data: T;
	/** frontmatter 之后的正文 */
	body: string;
}

// ── 公共 API ──

/**
 * 解析 frontmatter（无 schema，返回原始 key-value）
 */
export function parseFrontmatter(content: string): RawFrontmatter;
/**
 * 解析 frontmatter（有 schema，返回强类型结果或 null）
 *
 * @example
 * ```ts
 * const ScheduleSchema = z.object({
 *   name: z.string(),
 *   cron: z.string(),
 *   enabled: z.preprocess(v => v !== "false", z.boolean()),
 * });
 * const result = parseFrontmatter(content, ScheduleSchema);
 * if (result) console.log(result.data.name); // typed!
 * ```
 */
export function parseFrontmatter<T>(
	content: string,
	schema: ZodType<T>,
): TypedFrontmatter<T> | null;
export function parseFrontmatter<T>(
	content: string,
	schema?: ZodType<T>,
): RawFrontmatter | TypedFrontmatter<T> | null {
	const match = content.match(
		/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/,
	);
	if (!match) {
		if (schema) return null;
		return { meta: {}, body: content.trim() };
	}

	const rawMeta = parseSimpleYaml(match[1] ?? "");
	const body = (match[2] ?? "").trim();

	if (!schema) {
		return { meta: rawMeta, body };
	}

	const result = schema.safeParse(rawMeta);
	if (!result.success) return null;

	return { data: result.data, body };
}

/**
 * 提取嵌套块（如 metadata: 下的缩进 key-value）
 */
export function extractNestedBlock(
	yaml: string,
	blockName: string,
): Record<string, string> | null {
	const lines = yaml.split(/\r?\n/);
	const result: Record<string, string> = {};
	let inBlock = false;

	for (const line of lines) {
		if (line.startsWith(`${blockName}:`)) {
			inBlock = true;
			continue;
		}
		if (inBlock) {
			if (line.startsWith("  ") || line.startsWith("\t")) {
				const parsed = parseYamlLine(line.trim());
				if (parsed) result[parsed.key] = parsed.value;
			} else {
				break;
			}
		}
	}

	return Object.keys(result).length > 0 ? result : null;
}

/**
 * 提取 frontmatter 原始 YAML 文本（用于 extractNestedBlock）
 */
export function extractRawYaml(content: string): string | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	return match?.[1] ?? null;
}

// ── 内部函数 ──

function parseSimpleYaml(yaml: string): Record<string, string> {
	const result: Record<string, string> = {};

	for (const line of yaml.split(/\r?\n/)) {
		if (line.startsWith(" ") || line.startsWith("\t") || !line.trim())
			continue;
		const parsed = parseYamlLine(line);
		if (parsed) result[parsed.key] = parsed.value;
	}

	return result;
}

function parseYamlLine(
	line: string,
): { key: string; value: string } | null {
	const colonIdx = line.indexOf(":");
	if (colonIdx === -1) return null;

	const key = line.slice(0, colonIdx).trim();
	let value = line.slice(colonIdx + 1).trim();

	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1);
	}

	if (!key || !value) return null;
	return { key, value };
}
