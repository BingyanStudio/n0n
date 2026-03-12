/**
 * @n0n/shared — 跨包共享的纯工具函数
 *
 * 不依赖任何配置或运行时状态。
 * 所有函数都是纯函数，通过参数接收所需上下文。
 */

// AGENTS.md
export { formatAgentsMdPrompt, loadAgentsMd } from "./agents-md.ts";
// Frontmatter
export type { RawFrontmatter, TypedFrontmatter } from "./frontmatter.ts";
export {
	extractNestedBlock,
	extractRawYaml,
	parseFrontmatter,
} from "./frontmatter.ts";
export {
	discoverSkills,
	formatSkillContents,
	formatSkillSummaries,
	loadSkillContent,
	loadSkillContents,
} from "./skills/discovery.ts";
// Skills
export type { SkillContent, SkillMeta } from "./skills/types.ts";
// Tags
export {
	adaptTagsFor,
	closeTag,
	detectTagStyle,
	openTag,
	type TagStyle,
	wrapTagFor,
} from "./tags.ts";
// Workspace
export type { BaseWorkspacePaths } from "./workspace.ts";
export {
	ensureDirs,
	parseWorkspaceArg,
	resolveBasePaths,
} from "./workspace.ts";
