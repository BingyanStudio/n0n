/**
 * help 命令：列出所有 activation=auto 的 skill
 *
 * 输出设计：
 * - 列出 name + description
 * - 末尾附引导文本，引导模型按需加载 skill
 */

import { discoverSkillsMultiDir } from "@n0n/shared";
import { getSkillDirs } from "../paths.ts";

export async function helpCommand(): Promise<void> {
	const skills = await discoverSkillsMultiDir(getSkillDirs());
	const autoSkills = skills.filter((s) => s.activation === "auto");

	if (autoSkills.length === 0) {
		console.log("没有可用的 skill。运行 `n0n-skill init` 安装内置 skill。");
		return;
	}

	console.log("可用 Skills：\n");
	for (const skill of autoSkills) {
		console.log(`  ${skill.name} — ${skill.description}`);
	}

	console.log(
		"\n---\n在响应用户请求前，检查是否有合适的 skill 可以加载。使用 `n0n-skill read <name>` 获取完整方法论。",
	);
}
