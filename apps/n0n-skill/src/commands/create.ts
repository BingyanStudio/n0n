/**
 * create 命令：创建新 skill 脚手架
 *
 * 在 ~/.n0n/skills/<name>/ 下生成 SKILL.md 模板。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getUserSkillsDir } from "../paths.ts";

const SKILL_TEMPLATE = (name: string) => `---
name: ${name}
description: TODO - 描述此 skill 的用途和触发条件
activation: auto
---

# ${name}

TODO - 在此编写方法论指令。
`;

export async function createCommand(name: string | undefined): Promise<void> {
	if (!name) {
		console.error("用法: n0n-skill create <name>");
		console.error("  name 必须是小写字母、数字和连字符组成的标识符。");
		process.exit(1);
	}

	if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) || name.includes("--")) {
		console.error(
			`无效的 skill 名称 "${name}"。必须是小写字母、数字和连字符，不能包含连续连字符。`,
		);
		process.exit(1);
	}

	const skillDir = resolve(getUserSkillsDir(), name);

	if (existsSync(skillDir)) {
		console.error(`skill "${name}" 已存在于 ${skillDir}`);
		process.exit(1);
	}

	mkdirSync(skillDir, { recursive: true });
	writeFileSync(resolve(skillDir, "SKILL.md"), SKILL_TEMPLATE(name), "utf-8");
	mkdirSync(resolve(skillDir, "scripts"), { recursive: true });
	mkdirSync(resolve(skillDir, "references"), { recursive: true });

	console.log(`✓ 已创建 skill 脚手架: ${skillDir}`);
	console.log("  编辑 SKILL.md 添加方法论内容。");
}
