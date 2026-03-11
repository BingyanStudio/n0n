/**
 * Skill 数据类型
 */

/** Skill 元数据（从 SKILL.md frontmatter 解析） */
export interface SkillMeta {
	/** 短标识符（必须匹配目录名） */
	name: string;
	/** 描述：做什么、何时使用 */
	description: string;
	/** SKILL.md 绝对路径 */
	path: string;
	/** skill 目录绝对路径 */
	dir: string;
	/** 可选：许可证 */
	license?: string;
	/** 可选：兼容性说明 */
	compatibility?: string;
	/** 可选：额外元数据 */
	metadata?: Record<string, string>;
}

/** Skill 完整内容（元数据 + 指令正文） */
export interface SkillContent extends SkillMeta {
	/** SKILL.md 的 Markdown 正文（frontmatter 之后的部分） */
	body: string;
	/** skill 目录下的脚本文件列表（相对路径） */
	scripts: string[];
}
