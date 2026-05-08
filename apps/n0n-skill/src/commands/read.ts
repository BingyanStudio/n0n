/**
 * read 命令：读取指定 skill 的完整内容
 *
 * auto 和 manual 的 skill 都可以读取。
 */

import { discoverSkillsMultiDir, loadSkillContent } from "@n0n/shared";
import { getSkillDirs } from "../paths.ts";

export async function readCommand(name: string | undefined): Promise<void> {
	if (!name) {
		console.error("用法: n0n-skill read <name>");
		process.exit(1);
	}

	const skills = await discoverSkillsMultiDir(getSkillDirs());
	const skill = skills.find((s) => s.name === name);

	if (!skill) {
		const available = skills.map((s) => s.name).join(", ");
		console.error(`skill "${name}" 不存在。可用: ${available || "(无)"}`);
		process.exit(1);
	}

	const content = await loadSkillContent(skill.path);
	if (!content) {
		console.error(`无法加载 skill "${name}" 的内容。`);
		process.exit(1);
	}

	// 输出完整 SKILL.md 正文
	console.log(content.body);

	// 如果有可用脚本，附加说明
	if (content.scripts.length > 0) {
		console.log(`\n可用脚本（使用 bun run ${content.dir}/<script> 执行）：`);
		for (const script of content.scripts) {
			console.log(`  - ${script}`);
		}
	}
}
