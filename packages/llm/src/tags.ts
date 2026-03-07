/**
 * 动态 XML Tag 风格 — 根据 LLM 模型自动切换标签格式
 *
 * 不同模型对 XML-like 标签的理解不同，使用各模型训练时的原生标签风格
 * 可以获得更好的结构化理解效果。
 *
 * - Deepseek: <|DSML|tag> content <|/DSML|tag>
 * - GLM:      <tag> content </tag>
 * - Minimax:  ]~b]tag content [e~[
 * - 默认:     <tag> content </tag>  (标准 XML 风格)
 */

import { getLLMConfig } from "./config.ts";

type TagStyle = "deepseek" | "glm" | "minimax" | "default";

/**
 * 从模型名称推断 tag 风格
 */
function detectTagStyle(model: string): TagStyle {
	const m = model.toLowerCase();
	if (m.includes("deepseek")) return "deepseek";
	if (m.includes("glm")) return "glm";
	if (m.includes("minimax")) return "minimax";
	return "default";
}

/**
 * 生成开标签
 */
function openTag(style: TagStyle, name: string): string {
	switch (style) {
		case "deepseek":
			return `<|DSML|${name}>`;
		case "minimax":
			return `]~b]${name}`;
		case "glm":
		case "default":
			return `<${name}>`;
	}
}

/**
 * 生成闭标签
 */
function closeTag(style: TagStyle, name: string): string {
	switch (style) {
		case "deepseek":
			return `<|/DSML|${name}>`;
		case "minimax":
			return `[e~[`;
		case "glm":
		case "default":
			return `</${name}>`;
	}
}

/**
 * 将文本中的标准 XML 标签替换为当前模型的 tag 风格
 *
 * 匹配 <tagName> 和 </tagName> 形式，仅替换已知的语义标签。
 */
export function adaptTags(text: string): string {
	const style = detectTagStyle(getLLMConfig().model);
	if (style === "default" || style === "glm") return text;

	return text
		.replace(/<(\w+)>/g, (_, name) => openTag(style, name))
		.replace(/<\/(\w+)>/g, (_, name) => closeTag(style, name));
}

/**
 * 包裹内容为带标签的块
 */
export function wrapTag(name: string, content: string): string {
	const style = detectTagStyle(getLLMConfig().model);
	return `${openTag(style, name)}\n${content}\n${closeTag(style, name)}`;
}
