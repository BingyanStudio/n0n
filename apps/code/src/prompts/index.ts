/**
 * 提示词注册表
 *
 * 系统提示词在编译时静态导入。
 * code-v0.1.md 已迁移为 bugfix skill，不再作为独立提示词版本存在。
 */

import codeDefault from "./code.md" with { type: "text" };

/** 获取系统提示词 */
export function getPrompt(version?: string): string {
	if (version) {
		throw new Error(
			`提示词版本 "${version}" 不存在。方法论已迁移到 skill 系统，使用 @name 或 n0n-skill read 加载。`,
		);
	}
	return codeDefault;
}
