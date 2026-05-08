/**
 * install 命令：安装远程 skill
 *
 * 暂时只支持本地路径安装（复制到 ~/.n0n/skills/）。
 * 远程 git URL 支持作为后续迭代。
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { Glob } from "bun";
import { getUserSkillsDir } from "../paths.ts";

export async function installCommand(
	source: string | undefined,
): Promise<void> {
	if (!source) {
		console.error("用法: n0n-skill install <path>");
		console.error("  支持本地 skill 目录路径。");
		process.exit(1);
	}

	const absSource = resolve(source);
	const skillMdPath = resolve(absSource, "SKILL.md");

	if (!existsSync(skillMdPath)) {
		console.error(`"${absSource}" 不是有效的 skill 目录（缺少 SKILL.md）。`);
		process.exit(1);
	}

	const skillName = basename(absSource);
	const destDir = resolve(getUserSkillsDir(), skillName);

	if (!existsSync(getUserSkillsDir())) {
		mkdirSync(getUserSkillsDir(), { recursive: true });
	}

	// 复制 skill 目录
	if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
	const glob = new Glob("**/*");
	for (const rel of glob.scanSync({ cwd: absSource })) {
		const srcPath = resolve(absSource, rel);
		const destPath = resolve(destDir, rel);
		const destParent = resolve(destPath, "..");
		if (!existsSync(destParent)) mkdirSync(destParent, { recursive: true });
		await Bun.write(destPath, Bun.file(srcPath));
	}

	console.log(`✓ 已安装 skill "${skillName}" 到 ${destDir}`);
}
