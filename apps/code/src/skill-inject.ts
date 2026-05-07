/**
 * @name 解析与 skill 内容注入
 *
 * 识别用户输入中独占一行的 @name 语法，读取对应 skill 内容，
 * 将其作为 hint 注入消息，并从可见文本中移除 @name 行。
 */

import { readSkills, listSkills } from "@n0n/skill";
import type { SkillContent } from "@n0n/skill";

export interface SkillInjectResult {
	/** 移除了 @name 行后的用户文本 */
	cleanedText: string;
	/** 注入的 skill 内容（拼接为 hint 字符串），null 表示无 skill 唤起 */
	hint: string | null;
	/** 找不到的 skill 名称列表 */
	notFound: string[];
}

/** 匹配独占一行的 @name（name 由小写字母、数字、连字符组成） */
const SKILL_LINE_RE = /^@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/;

/**
 * 解析用户输入中的 @name 引用并读取 skill 内容。
 *
 * @returns 清理后的文本 + hint（skill 正文拼接）+ 未找到列表
 */
export async function parseAndInjectSkills(
	input: string,
): Promise<SkillInjectResult> {
	const lines = input.split(/\r?\n/);
	const skillNames: string[] = [];
	const cleanedLines: string[] = [];

	for (const line of lines) {
		const match = line.trim().match(SKILL_LINE_RE);
		if (match?.[1]) {
			skillNames.push(match[1]);
		} else {
			cleanedLines.push(line);
		}
	}

	if (skillNames.length === 0) {
		return { cleanedText: input, hint: null, notFound: [] };
	}

	const { found, notFound } = await readSkills(skillNames);

	const hint =
		found.length > 0 ? formatSkillHint(found) : null;

	return {
		cleanedText: cleanedLines.join("\n").trim(),
		hint,
		notFound,
	};
}

function formatSkillHint(skills: SkillContent[]): string {
	return skills
		.map((s) => {
			const header = `<skill name="${s.name}">`;
			const footer = "</skill>";
			return `${header}\n${s.body}\n${footer}`;
		})
		.join("\n\n");
}

/**
 * 列出可用 skill 名称（用于提示用户）
 */
export async function getAvailableSkillNames(): Promise<string[]> {
	const skills = await listSkills();
	return skills.map((s) => s.name);
}
