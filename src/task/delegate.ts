/**
 * delegateTask — 任务委托流水线
 *
 * 在调用 subagent 前做三件事：
 * 1. 调用 subagent 咨询最佳实践（意图增强）
 * 2. RAG 检索相关的 memory/skill/history
 * 3. 组装所有上下文，提交给 subagent 执行
 */

import { subagent } from "../agent/subagent.ts";
import type { RagHit } from "./rag.ts";
import { ragSearch } from "./rag.ts";

export interface TaskResult<T = unknown> {
	result: T;
	report: string | null;
	history: import("../types/domain.ts").DomainMessage[];
}

/**
 * delegateTask 主入口
 */
export async function delegateTask(
	query: string,
	options?: {
		validateResult?: (result: unknown) => string | null;
		skipConsultation?: boolean;
	},
): Promise<TaskResult> {
	// ── Step 1: 意图增强（咨询） ──
	let consultAdvice = "";
	if (!options?.skipConsultation) {
		try {
			const consultResult = await subagent(
				[
					`I want to accomplish the following task: "${query}"`,
					"",
					"Please provide:",
					"1. Best practices for this task",
					"2. Potential problems and solutions",
					"3. A recommended step-by-step approach",
					"",
					"Be concise and actionable. Submit your advice as the result.",
				].join("\n"),
				{ maxIterations: 15 },
			);
			consultAdvice =
				typeof consultResult.result === "string"
					? consultResult.result
					: JSON.stringify(consultResult.result);
		} catch {
			// 咨询失败不阻塞主流程
			consultAdvice = "(consultation unavailable)";
		}
	}

	// ── Step 2: RAG 检索 ──
	const [skillHits, memoryHits, historyHits] = await Promise.all([
		ragSearch(query, "skill"),
		ragSearch(query, "memory"),
		ragSearch(query, "history"),
	]);

	const ragContext = formatRagResults([
		...skillHits.results,
		...memoryHits.results,
		...historyHits.results,
	]);

	// ── Step 3: 组装上下文，执行 ──
	const enrichedPrompt = buildEnrichedPrompt(query, consultAdvice, ragContext);

	const result = await subagent(enrichedPrompt, {
		systemPrompt: [
			"You are a capable AI agent executing a delegated task.",
			"You have been provided with consultation advice and relevant context from previous work.",
			"Use the tools available to complete the task thoroughly.",
			"When done, use `submit` to deliver your result.",
		].join("\n"),
		validateResult: options?.validateResult,
	});

	return {
		result: result.result,
		report: result.report,
		history: result.history,
	};
}

// ── 辅助函数 ──

function formatRagResults(hits: RagHit[]): string {
	if (hits.length === 0) return "";

	const sections = hits.map(
		(h) => `### ${h.source} [${h.relevance}]\n${h.content}`,
	);
	return sections.join("\n\n---\n\n");
}

function buildEnrichedPrompt(
	query: string,
	advice: string,
	ragContext: string,
): string {
	const parts = [`## Task\n${query}`];

	if (advice && advice !== "(consultation unavailable)") {
		parts.push(`## Consultation Advice\n${advice}`);
	}

	if (ragContext) {
		parts.push(`## Relevant Context\n${ragContext}`);
	}

	return parts.join("\n\n");
}
