/**
 * 动态 XML Tag 风格 — 自动从 LLM 配置读取模型名称
 *
 * 薄封装层：从 @n0n/shared 导入纯函数，注入当前 LLM 配置的 model。
 * 这样调用方不需要每次手动传 model 参数。
 */

import { adaptTagsFor, wrapTagFor } from "@n0n/shared";
import { getLLMConfig } from "./config.ts";

/**
 * 将文本中的标准 XML 标签替换为当前模型的 tag 风格
 */
export function adaptTags(text: string): string {
	return adaptTagsFor(text, getLLMConfig().model);
}

/**
 * 包裹内容为带标签的块（使用当前模型的 tag 风格）
 */
export function wrapTag(name: string, content: string): string {
	return wrapTagFor(name, content, getLLMConfig().model);
}
