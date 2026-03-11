/**
 * delegateTask — 任务委托流水线（高层 API）
 *
 * consultation → RAG → agentLoop
 */

import { resolve } from "node:path";
import type { DomainMessage } from "@n0n/types";
import type { ZodType } from "zod";
import { agentLoop } from "../agent/loop.ts";
import { formatAgentsMdPrompt, loadAgentsMd } from "../prompts/agents-md.ts";
import delegatePromptText from "../prompts/delegate.md" with { type: "text" };
import { discoverSkills, formatSkillSummaries } from "../skills/discovery.ts";
import { discoverWorkflows } from "../workflow/runtime.ts";
import type { WorkflowPaths } from "../workspace.ts";
import type { RagHit } from "./rag.ts";
import { ragSearch } from "./rag.ts";

export interface TaskResult<T = unknown> {
	result: T | null;
	report: string | null;
	history: DomainMessage[];
}

export async function delegateTask<T = unknown>(
	query: string,
	options: {
		schema?: ZodType<T>;
		skipConsultation?: boolean;
		maxIterations?: number;
		paths: WorkflowPaths;
	},
): Promise<TaskResult<T>> {
	const resolvedPaths = options.paths;
	const allSkills = await discoverSkills(resolvedPaths.skills);
	const skillSummaryText = formatSkillSummaries(allSkills);

	let consultAdvice = "";
	if (!options?.skipConsultation) {
		try {
			const skillSection = skillSummaryText
				? [
						"",
						`## Available Skills (in ${resolvedPaths.skills}/)`,
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
				toolsWorkspace: {
					workspace: resolvedPaths.workspace,
					tempDir: resolvedPaths.temp,
				},
			});
			consultAdvice =
				typeof consultResult.result === "string"
					? consultResult.result
					: JSON.stringify(consultResult.result);

			const hash = Bun.hash(query).toString(36);
			const filePath = resolve(resolvedPaths.consultResult, `${hash}.md`);
			const now = new Date().toISOString();
			await Bun.write(
				filePath,
				`---\nquery: "${query.replaceAll('"', '\\"')}"\ncreated: ${now}\ntype: consult-result\n---\n\n${consultAdvice}`,
			);
		} catch (err) {
			if (err instanceof Error && "status" in err) {
				const status = (err as { status: number }).status;
				if (status === 401 || status === 403) throw err;
			}
			console.error("  [delegateTask] consultation failed:", err);
			consultAdvice = "(consultation unavailable)";
		}
	}

	const [ragHits, workflows] = await Promise.all([
		ragSearch(query, "all", resolvedPaths),
		discoverWorkflows(false, resolvedPaths),
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

	const enrichedPrompt = buildEnrichedPrompt(
		query,
		consultAdvice,
		ragContext,
		workflowList,
	);

	let systemPrompt = delegatePromptText;

	const agentsMd = await loadAgentsMd(resolvedPaths.workspace);
	if (agentsMd) {
		systemPrompt += `\n\n${formatAgentsMdPrompt(agentsMd)}`;
	}

	const history: DomainMessage[] = [
		{ type: "system", content: systemPrompt },
		{ type: "user_text", content: enrichedPrompt },
	];

	const result = await agentLoop(history, {
		schema: options?.schema,
		maxIterations: options?.maxIterations,
		toolsWorkspace: {
			workspace: resolvedPaths.workspace,
			tempDir: resolvedPaths.temp,
		},
	});

	return {
		result: result.result,
		report: result.report,
		history: result.history,
	};
}

function formatRagResults(hits: RagHit[]): string {
	if (hits.length === 0) return "";
	return hits
		.map((h) => `### ${h.source} [${h.relevance}]\n${h.content}`)
		.join("\n\n---\n\n");
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
