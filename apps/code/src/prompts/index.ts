/**
 * 提示词注册表
 *
 * 所有版本在编译时静态导入，打包为 Record<string, string>，
 * 避免运行时 IO 和文件找不到的问题。
 *
 * 版本定位：顶层建筑（角色、约束、交互协议、认知框架），
 * 具体领域方法论由 skill 系统按需加载。
 *
 * 添加新版本：在此文件新增一行 import + prompts 条目即可。
 */

import codeDefault from "./code.md" with { type: "text" };
import codeV02 from "./code-v0.2.md" with { type: "text" };

/** 版本号 → 提示词文本。空字符串 key 为默认版本。 */
export const prompts: Record<string, string> = {
	"": codeDefault,
	"0.2": codeV02,
};

/** 列出所有可用版本 */
export function availableVersions(): string[] {
	return Object.keys(prompts).filter((k) => k !== "");
}

/** 获取指定版本的提示词，不存在则抛出明确错误 */
export function getPrompt(version?: string): string {
	const key = version ?? "";
	const text = prompts[key];
	if (text == null) {
		throw new Error(
			`提示词版本 "${version}" 不存在。可用版本: ${availableVersions().join(", ")}`,
		);
	}
	return text;
}
