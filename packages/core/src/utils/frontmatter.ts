/**
 * Frontmatter 解析工具 — 统一的 YAML frontmatter 解析
 *
 * 支持简单的 key: value 格式和一层嵌套（如 metadata 块）。
 * 供 skill discovery 和 scheduler 共享。
 */

export interface FrontmatterResult {
	/** 顶层 key-value 对 */
	meta: Record<string, string>;
	/** frontmatter 之后的正文 */
	body: string;
}

/**
 * 解析 `---` 分隔的 YAML frontmatter + Markdown 正文
 */
export function parseFrontmatter(content: string): FrontmatterResult {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { meta: {}, body: content.trim() };

	const meta = parseSimpleYaml(match[1] ?? "");
	const body = (match[2] ?? "").trim();

	return { meta, body };
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
		// 跳过缩进行（属于嵌套块）和空行
		if (line.startsWith(" ") || line.startsWith("\t") || !line.trim()) continue;
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

	// 去除引号
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		value = value.slice(1, -1);
	}

	if (!key || !value) return null;
	return { key, value };
}
