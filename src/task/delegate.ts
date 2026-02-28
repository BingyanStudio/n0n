/**
 * delegateTask — 任务委托流水线（高层 API）
 *
 * 在调用 subagent 前做三件事：
 * 1. 调用 subagent 咨询最佳实践（意图增强）
 * 2. RAG 检索相关的 memory/skill/history
 * 3. 组装所有上下文，提交给 subagent 执行
 *
 * Workflow 中应优先使用此函数而非底层 subagent。
 */

import { resolve } from "node:path";
import type { ZodType } from "zod";
import { subagent } from "../agent/subagent.ts";
import type { DomainMessage } from "../types/domain.ts";
import { discoverWorkflows } from "../workflow/runtime.ts";
import type { RagHit } from "./rag.ts";
import { ragSearch } from "./rag.ts";

export interface TaskResult<T = unknown> {
	result: T | null;
	report: string | null;
	history: DomainMessage[];
}

/**
 * delegateTask 主入口
 */
export async function delegateTask<T = unknown>(
	query: string,
	options?: {
		/** Zod schema 校验成功结果 */
		schema?: ZodType<T>;
		skipConsultation?: boolean;
		maxIterations?: number;
	},
): Promise<TaskResult<T>> {
	// ── Step 1: 意图增强（咨询） ──
	let consultAdvice = "";
	if (!options?.skipConsultation) {
		try {
			const consultHistory: DomainMessage[] = [
				{
					type: "system",
					content:
						"You are a consultant. Provide concise, actionable advice. Use submit to deliver your advice.",
				},
				{
					type: "user_text",
					content: [
						`I want to accomplish: "${query}"`,
						"",
						"Please provide:",
						"1. Best practices for this task",
						"2. Potential problems and solutions",
						"3. A recommended step-by-step approach",
						"",
						"Be concise. Submit your advice as a string.",
					].join("\n"),
				},
			];
			const consultResult = await subagent(consultHistory, {
				maxIterations: 15,
			});
			consultAdvice =
				typeof consultResult.result === "string"
					? consultResult.result
					: JSON.stringify(consultResult.result);

			// 写入 consult-result 供后续 RAG 检索复用
			const hash = Bun.hash(query).toString(36);
			const filePath = resolve(`workflows/consult-result/${hash}.md`);
			const now = new Date().toISOString();
			await Bun.write(
				filePath,
				`---\nquery: "${query.replaceAll('"', '\\"')}"\ncreated: ${now}\ntype: consult-result\n---\n\n${consultAdvice}`,
			);
		} catch (err) {
			// 致命错误（配置错误、认证失败）直接抛出，不静默降级
			if (err instanceof Error && "status" in err) {
				const status = (err as { status: number }).status;
				if (status === 401 || status === 403) throw err;
			}
			console.error("  [delegateTask] consultation failed:", err);
			consultAdvice = "(consultation unavailable)";
		}
	}

	// ── Step 2: RAG 检索 + workflow 发现（并行） ──
	const [skillHits, memoryHits, historyHits, workflows] = await Promise.all([
		ragSearch(query, "skill"),
		ragSearch(query, "memory"),
		ragSearch(query, "history"),
		discoverWorkflows(),
	]);

	const ragContext = formatRagResults([
		...skillHits.results,
		...memoryHits.results,
		...historyHits.results,
	]);

	const workflowList =
		workflows.length > 0
			? workflows
					.map(
						(w) =>
							`- ${w.name}: ${w.description || "(no description)"} → ${w.path}`,
					)
					.join("\n")
			: "";

	// ── Step 3: 组装上下文，执行 ──
	const enrichedPrompt = buildEnrichedPrompt(
		query,
		consultAdvice,
		ragContext,
		workflowList,
	);

	const history: DomainMessage[] = [
		{
			type: "system",
			content: [
				"You are a capable AI agent executing a delegated task.",
				"You have been provided with consultation advice, relevant context, and a list of existing workflows.",
				"If an existing workflow matches the task, run it with `exec` (bun run src/main.ts run <path>) and submit its output.",
				"Otherwise, use the tools available to complete the task thoroughly.",
				"When done, use `submit` to deliver your result.",
			].join("\n"),
		},
		{
			type: "user_text",
			content: enrichedPrompt,
		},
	];

	const result = await subagent(history, {
		schema: options?.schema,
		maxIterations: options?.maxIterations,
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
	workflowList: string,
): string {
	const parts = [`## Task\n${query}`];

	if (workflowList) {
		parts.push(`## Available Workflows (reuse if applicable)\n${workflowList}`);
	}

	if (advice && advice !== "(consultation unavailable)") {
		parts.push(`## Consultation Advice\n${advice}`);
	}

	if (ragContext) {
		parts.push(`## Relevant Context\n${ragContext}`);
	}

	return parts.join("\n\n");
}
