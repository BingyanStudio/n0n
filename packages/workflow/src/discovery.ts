/**
 * 发现层 — 统一的资源发现入口
 */

export type { SkillContent, SkillMeta } from "@n0n/shared";
export {
	discoverSkills,
	formatSkillContents,
	formatSkillSummaries,
	loadSkillContent,
	loadSkillContents,
} from "@n0n/shared";

export type { WorkflowMeta } from "./types.ts";
export { discoverWorkflows } from "./workflow/runtime.ts";
