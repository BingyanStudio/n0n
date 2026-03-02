/**
 * delegateTask — 任务委托流水线（高层 API）
 *
 * 在调用 agentLoop 前做三件事：
 * 1. 调用 subagent 咨询最佳实践（意图增强）
 * 2. RAG 检索相关的 memory/skill/history
 * 3. 组装所有上下文，提交给 agentLoop 执行
 *
 * Workflow 中应优先使用此函数而非底层 agentLoop。
 */

import { resolve } from "node:path";
import type { ZodType } from "zod";
import { agentLoop } from "../agent/index.ts";
import { discoverSkills, formatSkillSummaries } from "../skills/index.ts";
import { ENV_INFO } from "../tools/index.ts";
import type { DomainMessage } from "../types/domain.ts";
import { discoverWorkflows } from "../workflow/runtime.ts";
import type { RagHit } from "./rag.ts";
import { ragSearch } from "./rag.ts";

const PROMPT_PATH = resolve(import.meta.dir, "prompts/delegate.md");

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
	// ── Step 0: Skill 发现（轻量，只读 frontmatter） ──
	const allSkills = await discoverSkills();
	const skillSummaryText = formatSkillSummaries(allSkills);

	// ── Step 1: 意图增强（咨询） ──
	let consultAdvice = "";
	if (!options?.skipConsultation) {
		try {
			const skillSection = skillSummaryText
				? [
						"",
						"## Available Skills (in workflows/skills/)",
						"The following skills are available. If any are relevant, mention them in your advice with their directory path so the executor can read their SKILL.md for detailed instructions.",
						skillSummaryText,
					].join("\n")
				: "";

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
						skillSection,
						"",
						"Be concise. Submit your advice as a string.",
					].join("\n"),
				},
			];
			const consultResult = await agentLoop(consultHistory, {
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
	const [ragHits, workflows] = await Promise.all([
		ragSearch(query, "all"),
		discoverWorkflows(),
	]);

	const ragContext = formatRagResults(ragHits.results);

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

	const envLine = `Environment: OS=${ENV_INFO.os}, Shell=${ENV_INFO.shell}, CWD=${ENV_INFO.cwd}`;
	const shellHint =
		ENV_INFO.os === "Windows"
			? 'IMPORTANT: You are on Windows. Use Windows commands (e.g., `type` instead of `cat`, `dir` instead of `ls`, `findstr` instead of `grep`). Paths use backslashes. You can also use `bun -e "..."` for cross-platform file operations.'
			: "You are on a Unix-like system. Standard shell commands (cat, ls, grep, etc.) are available.";

	const promptTemplate = await Bun.file(PROMPT_PATH).text();
	const systemPrompt = promptTemplate
		.replace("{{ENV_LINE}}", envLine)
		.replace("{{SHELL_HINT}}", shellHint);

	const history: DomainMessage[] = [
		{
			type: "system",
			content: systemPrompt,
		},
		{
			type: "user_text",
			content: enrichedPrompt,
		},
	];

	const result = await agentLoop(history, {
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
