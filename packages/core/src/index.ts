/**
 * @n0n/core — 公共 API 导出
 *
 * API 层级（由轻到重）：
 *   generate     — 轻量生成，走 agentLoop 但跳过 consultation + RAG
 *   delegateTask — 完整流水线：consultation → RAG → agentLoop
 *   agentLoop    — 底层 API，需要完全控制 DomainMessage[]
 */

// 确保配置在任何 API 调用前初始化
import "./config.ts";

// 路径配置
export { paths } from "./config.ts";

// Prompt 模板
export { INTERACTIVE_PROMPT_PATH, DELEGATE_PROMPT_PATH } from "./prompts/paths.ts";

// Agent Loop
export type { AgentOptions, AgentResult } from "./agent/loop.ts";
export { agentLoop } from "./agent/loop.ts";

// 发现层
export type { SkillContent, SkillMeta, WorkflowMeta } from "./discovery.ts";
export type { WorkflowModule } from "./workflow/runtime.ts";
export {
	discoverSkills,
	discoverWorkflows,
	loadSkillContent,
} from "./discovery.ts";
// 调度
export type { ScheduleEntry } from "./scheduler/scheduler.ts";
export {
	loadSchedules,
	setScheduleEnabled,
	startScheduler,
	stopScheduler,
} from "./scheduler/scheduler.ts";
// Schema（供 cli 和 feishu 共享）
export type { InteractiveResult } from "./schema.ts";
export { InteractiveResultSchema } from "./schema.ts";
export type { TaskResult } from "./task/delegate.ts";
export { delegateTask } from "./task/delegate.ts";
// 高层 API
export type {
	GenerateOptions,
	GenerateResult,
} from "./task/generate.ts";
export { generate } from "./task/generate.ts";
export type {
	RagSearchResult,
	SearchSpace,
} from "./task/rag.ts";
export { ragSearch } from "./task/rag.ts";
// PlainRenderer（供需要默认渲染器的场景）
export { PlainRenderer } from "./ui/renderer.ts";
// Workflow 运行时
export { runWorkflow } from "./workflow/runtime.ts";
