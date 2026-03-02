/**
 * n0n — 公共 API 导出
 *
 * API 层级（由轻到重）：
 *   delegateTask — 完整流水线：consultation → RAG → agentLoop
 *   agentLoop    — 底层 API，需要完全控制 DomainMessage[]
 */

export type { AgentOptions, AgentResult } from "./agent/index.ts";
// 底层 API — 需要完全控制 DomainMessage[] 时使用
export { agentLoop } from "./agent/index.ts";
export type { ScheduleEntry } from "./scheduler/index.ts";
// 调度
export { loadSchedules, startScheduler } from "./scheduler/index.ts";
export type { SkillContent, SkillMeta } from "./skills/index.ts";
// Skills
export { discoverSkills, loadSkillContent } from "./skills/index.ts";
export type { RagSearchResult, SearchSpace, TaskResult } from "./task/index.ts";
// 高层 API — workflow 中优先使用
export { delegateTask, ragSearch } from "./task/index.ts";
// 类型
export type * from "./types/index.ts";
export type { WorkflowMeta } from "./workflow/index.ts";
// Workflow 运行时
export { discoverWorkflows, runWorkflow } from "./workflow/index.ts";
