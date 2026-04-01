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
 *
 * 集成策略：不在一开始推送所有技能，而是在咨询阶段（delegateTask）
 * 由专家根据任务主动挑选合适的 skills 推送给执行 agent。
 */

import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Glob } from "bun";
import { z } from "zod";
import {
	extractNestedBlock,
	extractRawYaml,
	parseFrontmatter as parseFM,
} from "../frontmatter.ts";
import type { SkillContent, SkillMeta } from "./types.ts";

export type { SkillContent, SkillMeta } from "./types.ts";

/**
 * 发现所有 skill：扫描 SKILL.md，只解析 frontmatter（轻量）
 */
export async function discoverSkills(baseDir: string): Promise<SkillMeta[]> {
	const absBase = resolve(baseDir);
	if (!existsSync(absBase)) return [];

	const glob = new Glob("*/SKILL.md");
	const files = Array.from(glob.scanSync({ cwd: absBase }));

	const skills: SkillMeta[] = [];

	for (const rel of files) {
		const absPath = resolve(absBase, rel);
		try {
			const content = await Bun.file(absPath).text();
			const meta = parseSkillMeta(content, absPath);
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
		const meta = parseSkillMeta(content, skillPath);
		if (!meta) return null;

		const { body } = parseFM(content);

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

/** Skill frontmatter 的 Zod schema — 解析时自动校验 */
const SkillFrontmatterSchema = z.object({
	name: z
		.string()
		.regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/)
		.refine((s) => !s.includes("--"), "name must not contain '--'"),
	description: z.string(),
	license: z.string().optional(),
	compatibility: z.string().optional(),
});

/**
 * 解析 YAML frontmatter，提取 skill 元数据
 */
function parseSkillMeta(content: string, filePath: string): SkillMeta | null {
	const result = parseFM(content, SkillFrontmatterSchema);

	if (!result) return null;

	const { data } = result;
	const rawYaml = extractRawYaml(content);

	if (!rawYaml) return null;

	const dir = resolve(filePath, "..");
	const dirName = basename(dir);
	if (dirName !== data.name) {
		console.error(
			`  [skills] name "${data.name}" doesn't match directory "${dirName}", skipping`,
		);
		return null;
	}

	const meta: SkillMeta = {
		name: data.name,
		description: data.description,
		path: resolve(filePath),
		dir,
	};

	if (data.license) meta.license = data.license;
	if (data.compatibility) meta.compatibility = data.compatibility;

	const metadataRaw = extractNestedBlock(rawYaml, "metadata");
	if (metadataRaw && Object.keys(metadataRaw).length > 0) {
		meta.metadata = metadataRaw;
	}

	return meta;
}
