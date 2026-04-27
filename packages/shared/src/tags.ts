/**
 * XML-like Tag 工具 — TagAdapter 工厂 + 纯函数底层
 *
 * 不同 LLM 模型对 XML-like 标签的理解不同，
 * 使用各模型训练时的原生标签风格可以获得更好的结构化理解效果。
 *
 * - GLM:      <tag> content </tag>
 * - Minimax:  ]~b]tag content [e~[
 * - 默认:     <tag> content </tag>  (标准 XML 风格)
 *
 * DeepSeek 的 DSML 标签不在公共层处理——由 DeepSeekClient 内部按需使用。
 *
 * 各 LLM Client 通过 createTagAdapter(style) 构造 TagAdapter 实例，
 * 注入到 formatPrompt。
 */

import type { TagAdapter, TagStyle } from "@n0n/types";
export type { TagAdapter, TagStyle };

/** 从模型名称推断 tag 风格（fallback，优先使用 ProviderConfig.tagStyle） */
export function detectTagStyle(model: string): TagStyle {
	const m = model.toLowerCase();
	if (m.includes("glm")) return "glm";
	if (m.includes("minimax")) return "minimax";
	return "default";
}

/** 生成开标签 */
export function openTag(style: TagStyle, name: string): string {
	switch (style) {
		case "minimax":
			return `]~b]${name}`;
		case "glm":
		case "default":
			return `<${name}>`;
	}
}

/** 生成闭标签 */
export function closeTag(style: TagStyle, name: string): string {
	switch (style) {
		case "minimax":
			return "[e~[";
		case "glm":
		case "default":
			return `</${name}>`;
	}
}

/**
 * 将文本中的标准 XML 标签替换为指定风格。
 * 匹配 <tagName> 和 </tagName> 形式。
 */
function adaptTagsByStyle(text: string, style: TagStyle): string {
	if (style === "default" || style === "glm") return text;

	return text
		.replace(/<(\w+)>/g, (_, name) => openTag(style, name))
		.replace(/<\/(\w+)>/g, (_, name) => closeTag(style, name));
}

/** 用指定风格包裹内容 */
function wrapTagByStyle(
	name: string,
	content: string,
	style: TagStyle,
): string {
	return `${openTag(style, name)}\n${content}\n${closeTag(style, name)}`;
}

/**
 * 创建标准 TagAdapter — 基于 TagStyle 的通用实现。
 *
 * 大多数 provider（OpenAI、Anthropic、Gemini、DeepSeek）使用此工厂。
 */
export function createTagAdapter(style: TagStyle): TagAdapter {
	return {
		wrapTag: (name, content) => wrapTagByStyle(name, content, style),
		adaptTags: (text) => adaptTagsByStyle(text, style),
	};
}

// ── 兼容导出（过渡期，供未迁移的调用方使用） ──

/** @deprecated 使用 createTagAdapter(style).adaptTags(text) */
export function adaptTagsFor(text: string, model: string): string {
	return adaptTagsByStyle(text, detectTagStyle(model));
}

/** @deprecated 使用 createTagAdapter(style).wrapTag(name, content) */
export function wrapTagFor(
	name: string,
	content: string,
	model: string,
): string {
	return wrapTagByStyle(name, content, detectTagStyle(model));
}
