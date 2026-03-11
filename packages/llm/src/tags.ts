/**
 * 动态 XML Tag 风格 — 根据模型名称自动选择 tag 格式
 */

import { adaptTagsFor, wrapTagFor } from "@n0n/shared";

/**
 * 将文本中的标准 XML 标签替换为指定模型的 tag 风格
 */
export function adaptTags(text: string, model: string): string {
	return adaptTagsFor(text, model);
}

/**
 * 包裹内容为带标签的块（使用指定模型的 tag 风格）
 */
export function wrapTag(name: string, content: string, model: string): string {
	return wrapTagFor(name, content, model);
}
