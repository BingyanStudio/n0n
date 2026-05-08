/**
 * n0n-skill 编程接口
 *
 * 供 apps/code 等消费者直接调用（不走 CLI），确保行为一致。
 */

import { discoverSkillsMultiDir, loadSkillContent } from "@n0n/shared";
import type { SkillContent, SkillMeta } from "@n0n/shared";
import { getSkillDirs } from "./paths.ts";

export type { SkillContent, SkillMeta };

/** 获取所有 skill 元数据 */
export async function listSkills(): Promise<SkillMeta[]> {
	return discoverSkillsMultiDir(getSkillDirs());
}

/** 读取指定 skill 的完整内容，不存在返回 null */
export async function readSkill(
	name: string,
): Promise<SkillContent | null> {
	const skills = await discoverSkillsMultiDir(getSkillDirs());
	const skill = skills.find((s) => s.name === name);
	if (!skill) return null;
	return loadSkillContent(skill.path);
}

/** 批量读取多个 skill 的完整内容 */
export async function readSkills(
	names: string[],
): Promise<{ found: SkillContent[]; notFound: string[] }> {
	const skills = await discoverSkillsMultiDir(getSkillDirs());
	const found: SkillContent[] = [];
	const notFound: string[] = [];

	for (const name of names) {
		const skill = skills.find((s) => s.name === name);
		if (!skill) {
			notFound.push(name);
			continue;
		}
		const content = await loadSkillContent(skill.path);
		if (content) found.push(content);
		else notFound.push(name);
	}

	return { found, notFound };
}
