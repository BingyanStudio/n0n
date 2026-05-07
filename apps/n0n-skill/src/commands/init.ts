/**
 * init 命令：将内置 skill 写入 ~/.n0n/builtin-skills/
 *
 * 内置 skill 作为源文件打包在 apps/n0n-skill/builtin/ 目录中，
 * init 命令将其复制到全局配置目录。
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { Glob } from "bun";
import { getBuiltinSkillsDir } from "../paths.ts";

/** 内置 skill 源目录（相对于此文件的位置） */
const BUILTIN_SOURCE = resolve(import.meta.dir, "../../builtin");

export async function initCommand(): Promise<void> {
	const targetDir = getBuiltinSkillsDir();

	if (!existsSync(BUILTIN_SOURCE)) {
		console.error("内置 skill 源目录不存在。安装可能不完整。");
		process.exit(1);
	}

	// 扫描 builtin/ 下的所有 skill 目录
	const glob = new Glob("*/SKILL.md");
	const skillFiles = Array.from(glob.scanSync({ cwd: BUILTIN_SOURCE }));

	if (skillFiles.length === 0) {
		console.log("没有找到内置 skill。");
		return;
	}

	let count = 0;
	for (const rel of skillFiles) {
		const skillDir = resolve(BUILTIN_SOURCE, rel, "..");
		const skillName = basename(skillDir);
		const destDir = resolve(targetDir, skillName);

		// 递归复制整个 skill 目录
		await copyDir(skillDir, destDir);
		count++;
	}

	console.log(`✓ 已初始化 ${count} 个内置 skill 到 ${targetDir}`);
}

async function copyDir(src: string, dest: string): Promise<void> {
	if (!existsSync(dest)) mkdirSync(dest, { recursive: true });

	const glob = new Glob("**/*");
	for (const rel of glob.scanSync({ cwd: src })) {
		const srcPath = resolve(src, rel);
		const destPath = resolve(dest, rel);
		const file = Bun.file(srcPath);
		const stat = await file.exists();
		if (!stat) continue;

		// 确保目标子目录存在
		const destParent = resolve(destPath, "..");
		if (!existsSync(destParent)) mkdirSync(destParent, { recursive: true });

		await Bun.write(destPath, file);
	}
}
