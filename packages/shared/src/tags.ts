/**
 * XML-like Tag 工具 — 纯函数版本，不依赖任何配置
 *
 * 不同 LLM 模型对 XML-like 标签的理解不同，
 * 使用各模型训练时的原生标签风格可以获得更好的结构化理解效果。
 *
 * - Deepseek: <|DSML|tag> content <|/DSML|tag>
 * - GLM:      <tag> content </tag>
 * - Minimax:  ]~b]tag content [e~[
 * - 默认:     <tag> content </tag>  (标准 XML 风格)
 */

export type TagStyle = "deepseek" | "glm" | "minimax" | "default";

/** 从模型名称推断 tag 风格 */
// COMMENT: 模型特定的 tag 风格适配是一个容易被忽视的细节。
// DeepSeek 在训练时使用了 <|DSML|> 前缀的标签，用标准 XML 标签时模型的
// 结构化理解能力会显著下降。这本质上是"用模型的母语和它说话"。
// 但基于模型名称字符串的推断是脆弱的——如果用户通过代理访问 DeepSeek
// 但模型名被改写了，tag 风格就会回退到 default。
// 可以考虑让 tag 风格也成为 ProviderConfig 的一部分，而非从模型名推断。
export function detectTagStyle(model: string): TagStyle {
	const m = model.toLowerCase();
	if (m.includes("deepseek")) return "deepseek";
	if (m.includes("glm")) return "glm";
	if (m.includes("minimax")) return "minimax";
	return "default";
}

/** 生成开标签 */
export function openTag(style: TagStyle, name: string): string {
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

/** 生成闭标签 */
export function closeTag(style: TagStyle, name: string): string {
	switch (style) {
		case "deepseek":
			return `<|/DSML|${name}>`;
		case "minimax":
			return "[e~[";
		case "glm":
		case "default":
			return `</${name}>`;
	}
}

/**
 * 将文本中的标准 XML 标签替换为指定模型的 tag 风格。
 * 匹配 <tagName> 和 </tagName> 形式。
 */
export function adaptTagsFor(text: string, model: string): string {
	const style = detectTagStyle(model);
	if (style === "default" || style === "glm") return text;

	return text
		.replace(/<(\w+)>/g, (_, name) => openTag(style, name))
		.replace(/<\/(\w+)>/g, (_, name) => closeTag(style, name));
}

/** 用指定模型的 tag 风格包裹内容 */
export function wrapTagFor(
	name: string,
	content: string,
	model: string,
): string {
	const style = detectTagStyle(model);
	return `${openTag(style, name)}\n${content}\n${closeTag(style, name)}`;
}
