/**
 * @n0n/workflow — task pipeline + 资源发现
 *
 * API 层级（由轻到重）：
 *   generate     — 轻量生成，走 agentLoop 但跳过 consultation + RAG
 *   delegateTask — 完整流水线：consultation → RAG → agentLoop
 */

// 发现层
export type { SkillContent, SkillMeta, WorkflowMeta } from "./discovery.ts";
export {
	discoverSkills,
	discoverWorkflows,
	formatSkillContents,
	formatSkillSummaries,
	loadSkillContent,
	loadSkillContents,
} from "./discovery.ts";
// Schema
export type { InteractiveResult } from "./schema.ts";
export { InteractiveResultSchema } from "./schema.ts";
// Task pipeline
export type { TaskResult } from "./task/delegate.ts";
export { delegateTask } from "./task/delegate.ts";
export type { GenerateOptions, GenerateResult } from "./task/generate.ts";
export { generate } from "./task/generate.ts";
export { ragSearch } from "./task/rag.ts";
export type { RagSearchResult, SearchSpace } from "./types.ts";

// Workflow runtime
export type { WorkflowModule } from "./workflow/runtime.ts";
export { runWorkflow } from "./workflow/runtime.ts";

// Workspace
export type { WorkflowPaths } from "./workspace.ts";
export { resolveWorkflowPaths } from "./workspace.ts";
