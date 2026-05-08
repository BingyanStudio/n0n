/**
 * 提示词注册表
 *
 * 系统提示词只有一个版本（code.md）。
 * 方法论部分已拆解到 skill 中按需加载。
 */

import codeDefault from "./code.md" with { type: "text" };

/** 获取系统提示词 */
export function getPrompt(_version?: string): string {
	if (_version) {
		throw new Error(
			`提示词版本 "${_version}" 不存在。方法论已迁移到 skill 系统，使用 @name 或 n0n-skill read 加载。`,
		);
	}
	return codeDefault;
}
