/**
 * n0n — 公共 API 导出
 *
 * API 层级（由轻到重）：
 *   generate     — 轻量生成，走 agentLoop 但跳过 consultation + RAG
 *   delegateTask — 完整流水线：consultation → RAG → agentLoop
 *   agentLoop    — 底层 API，需要完全控制 DomainMessage[]
 */

export type { AgentOptions, AgentResult } from "./agent/index.ts";
// 底层 API — 需要完全控制 DomainMessage[] 时使用
export { agentLoop } from "./agent/index.ts";
// 发现层 — workflow / skill 发现
export type { SkillContent, SkillMeta, WorkflowMeta } from "./discovery.ts";
export {
	discoverSkills,
	discoverWorkflows,
	loadSkillContent,
} from "./discovery.ts";
export type { ScheduleEntry } from "./scheduler/index.ts";
// 调度
export { loadSchedules, startScheduler } from "./scheduler/index.ts";
export type {
	GenerateOptions,
	GenerateResult,
	RagSearchResult,
	SearchSpace,
	TaskResult,
} from "./task/index.ts";
// 高层 API — workflow 中优先使用
export { delegateTask, generate, ragSearch } from "./task/index.ts";
// 类型
export type * from "./types/index.ts";
// Workflow 运行时
export { runWorkflow } from "./workflow/index.ts";
