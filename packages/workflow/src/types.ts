/**
 * Workflow 包数据类型
 */

/** Workflow 元数据 */
export interface WorkflowMeta {
	name: string;
	path: string;
	description: string;
}

/** RAG 检索命中结果 */
export interface RagHit {
	source: string;
	content: string;
	relevance: "high" | "medium" | "low";
}

/** RAG 检索结果 */
export interface RagSearchResult {
	query: string;
	space: SearchSpace;
	results: RagHit[];
}

export type SearchSpace = "all" | "memory" | "skill" | "history";
