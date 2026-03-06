/**
 * Skill 发现与解析 — Agent Skills 标准格式
 *
 * 扫描 workflows/skills/\*\/SKILL.md，解析 YAML frontmatter 元数据。
 * Skills 目录作为 monorepo 设计，复用根目录 node_modules，
 * 每个 skill 的脚本可通过 `bun run` 直接执行。
 *
 * 目录结构：
 *   workflows/skills/
 *   ├── my-skill/
 *   │   ├── SKILL.md          # 必需：frontmatter + 指令
 *   │   ├── scripts/          # 可选：可执行脚本（bun run）
 *   │   ├── references/       # 可选：参考文档
 *   │   └── assets/           # 可选：模板、资源
 *   └── another-skill/
 *       └── SKILL.md
 */

import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Glob } from "bun";

/** Skill 元数据（从 SKILL.md frontmatter 解析） */
export interface SkillMeta {
	/** 短标识符（必须匹配目录名） */
	name: string;
	/** 描述：做什么、何时使用 */
	description: string;
	/** SKILL.md 绝对路径 */
	path: string;
	/** skill 目录绝对路径 */
	dir: string;
	/** 可选：许可证 */
	license?: string;
	/** 可选：兼容性说明 */
	compatibility?: string;
	/** 可选：额外元数据 */
	metadata?: Record<string, string>;
}

/** Skill 完整内容（元数据 + 指令正文） */
export interface SkillContent extends SkillMeta {
	/** SKILL.md 的 Markdown 正文（frontmatter 之后的部分） */
	body: string;
	/** skill 目录下的脚本文件列表（相对路径） */
	scripts: string[];
}

import { paths } from "../config.ts";

const SKILLS_DIR = paths.skills;

/**
 * 发现所有 skill：扫描 SKILL.md，只解析 frontmatter（轻量）
 */
export async function discoverSkills(
	baseDir = SKILLS_DIR,
): Promise<SkillMeta[]> {
	const absBase = resolve(baseDir);
	if (!existsSync(absBase)) return [];

	const glob = new Glob("*/SKILL.md");
	const files = Array.from(glob.scanSync({ cwd: absBase }));

	const skills: SkillMeta[] = [];

	for (const rel of files) {
		const absPath = resolve(absBase, rel);
		try {
			const content = await Bun.file(absPath).text();
			const meta = parseFrontmatter(content, absPath);
			if (meta) skills.push(meta);
		} catch {
			// 读取/解析失败，静默跳过
		}
	}

	return skills;
}

/**
 * 加载 skill 完整内容：元数据 + 指令正文 + 脚本列表
 */
export async function loadSkillContent(
	skillPath: string,
): Promise<SkillContent | null> {
	try {
		const content = await Bun.file(skillPath).text();
		const meta = parseFrontmatter(content, skillPath);
		if (!meta) return null;

		const body = extractBody(content);

		// 扫描 scripts/ 目录
		const scriptsDir = resolve(meta.dir, "scripts");
		const scripts: string[] = [];
		if (existsSync(scriptsDir)) {
			const scriptGlob = new Glob("**/*.{ts,js,sh}");
			for (const s of scriptGlob.scanSync({ cwd: scriptsDir })) {
				scripts.push(`scripts/${s.replace(/\\/g, "/")}`);
			}
		}

		return { ...meta, body, scripts };
	} catch {
		return null;
	}
}

/**
 * 批量加载多个 skill 的完整内容
 */
export async function loadSkillContents(
	skills: SkillMeta[],
): Promise<SkillContent[]> {
	const results = await Promise.all(
		skills.map((s) => loadSkillContent(s.path)),
	);
	return results.filter((r): r is SkillContent => r !== null);
}

/**
 * 生成 skill 摘要列表（用于注入 LLM context，每个 ~50-100 tokens）
 */
export function formatSkillSummaries(skills: SkillMeta[]): string {
	if (skills.length === 0) return "";

	return skills
		.map(
			(s) =>
				`- **${s.name}**: ${s.description}${s.compatibility ? ` (${s.compatibility})` : ""}`,
		)
		.join("\n");
}

/**
 * 生成 skill 完整内容的 XML 格式（用于注入执行上下文）
 */
export function formatSkillContents(contents: SkillContent[]): string {
	if (contents.length === 0) return "";

	return contents
		.map((s) => {
			const scriptInfo =
				s.scripts.length > 0
					? `\nAvailable scripts (run with \`bun run ${s.dir}/<script>\`):\n${s.scripts.map((p) => `  - ${p}`).join("\n")}`
					: "";

			return [
				`<skill name="${s.name}" path="${s.dir}">`,
				s.body,
				scriptInfo,
				"</skill>",
			]
				.filter(Boolean)
				.join("\n");
		})
		.join("\n\n");
}

// ── 内部解析函数 ──

/**
 * 解析 YAML frontmatter（简单实现，不依赖外部 YAML 库）
 *
 * 支持的字段：name, description, license, compatibility, metadata
 */
function parseFrontmatter(content: string, filePath: string): SkillMeta | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match?.[1]) return null;

	const yaml = match[1];
	const fields = parseSimpleYaml(yaml);

	const name = fields.name;
	const description = fields.description;

	if (!name || !description) return null;

	// 验证 name 格式
	if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) || name.includes("--")) {
		return null;
	}

	// 验证 name 匹配目录名
	const dir = resolve(filePath, "..");
	const dirName = basename(dir);
	if (dirName !== name) {
		console.error(
			`  [skills] name "${name}" doesn't match directory "${dirName}", skipping`,
		);
		return null;
	}

	const meta: SkillMeta = {
		name,
		description,
		path: resolve(filePath),
		dir,
	};

	if (fields.license) meta.license = fields.license;
	if (fields.compatibility) meta.compatibility = fields.compatibility;

	// metadata 子字段（简单处理：只取顶层 key-value）
	const metadataRaw = extractMetadataBlock(yaml);
	if (metadataRaw && Object.keys(metadataRaw).length > 0) {
		meta.metadata = metadataRaw;
	}

	return meta;
}

/**
 * 提取 frontmatter 之后的 Markdown 正文
 */
function extractBody(content: string): string {
	const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
	return match?.[1]?.trim() ?? "";
}

/**
 * 简单 YAML 解析：提取顶层 key: value 对
 * 不处理嵌套、数组等复杂结构（metadata 块单独处理）
 */
function parseSimpleYaml(yaml: string): Record<string, string> {
	const result: Record<string, string> = {};
	const lines = yaml.split(/\r?\n/);

	for (const line of lines) {
		// 跳过缩进行（属于嵌套块）和空行
		if (line.startsWith(" ") || line.startsWith("\t") || !line.trim()) continue;

		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;

		const key = line.slice(0, colonIdx).trim();
		let value = line.slice(colonIdx + 1).trim();

		// 去除引号
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		if (key && value) {
			result[key] = value;
		}
	}

	return result;
}

/**
 * 提取 metadata 嵌套块
 */
function extractMetadataBlock(yaml: string): Record<string, string> | null {
	const lines = yaml.split(/\r?\n/);
	const result: Record<string, string> = {};
	let inMetadata = false;

	for (const line of lines) {
		if (line.startsWith("metadata:")) {
			inMetadata = true;
			continue;
		}

		if (inMetadata) {
			// 缩进行属于 metadata 块
			if (line.startsWith("  ") || line.startsWith("\t")) {
				const trimmed = line.trim();
				const colonIdx = trimmed.indexOf(":");
				if (colonIdx === -1) continue;

				const key = trimmed.slice(0, colonIdx).trim();
				let value = trimmed.slice(colonIdx + 1).trim();

				if (
					(value.startsWith('"') && value.endsWith('"')) ||
					(value.startsWith("'") && value.endsWith("'"))
				) {
					value = value.slice(1, -1);
				}

				if (key && value) result[key] = value;
			} else {
				// 非缩进行 → metadata 块结束
				break;
			}
		}
	}

	return Object.keys(result).length > 0 ? result : null;
}
