/**
 * 发现层 — 统一的资源发现入口
 *
 * 将 workflow 和 skill 的发现能力聚合为基础设施层，
 * 消除 task → workflow / task → skills 的反向依赖。
 *
 * 上层模块（task、cli）统一从此处导入发现函数。
 */

// ── Skill 发现 ──
export type { SkillContent, SkillMeta } from "./skills/discovery.ts";
export {
	discoverSkills,
	formatSkillContents,
	formatSkillSummaries,
	loadSkillContent,
	loadSkillContents,
} from "./skills/discovery.ts";
// ── Workflow 发现 ──
export type { WorkflowMeta } from "./workflow/runtime.ts";
export { discoverWorkflows } from "./workflow/runtime.ts";
