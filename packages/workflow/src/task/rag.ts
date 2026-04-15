/**
 * RAG 检索 — LLM-as-Retriever 实现
 */

import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { getRuntime } from "@n0n/core";
import { Glob } from "bun";
import type { RagHit, RagSearchResult, SearchSpace } from "../types.ts";
import type { WorkflowPaths } from "../workspace.ts";

export type RagPaths = Pick<
	WorkflowPaths,
	"skills" | "memory" | "consultResult" | "history"
>;

interface Candidate {
	source: string;
	summary: string;
}

function getSpaceDirs(paths: RagPaths): Record<SearchSpace, string[]> {
	return {
		skill: [paths.skills],
		memory: [paths.memory, paths.consultResult],
		history: [paths.history],
		all: [paths.skills, paths.memory, paths.consultResult, paths.history],
	};
}

const SUMMARY_MAX_CHARS = 600;

async function collectCandidates(
	space: SearchSpace,
	paths: RagPaths,
): Promise<Candidate[]> {
	const dirs = getSpaceDirs(paths)[space];
	const candidates: Candidate[] = [];

	for (const dir of dirs) {
		const absDir = resolve(dir);
		if (!existsSync(absDir)) continue;

		const glob = new Glob("**/*");
		const files = Array.from(
			glob.scanSync({ cwd: absDir, absolute: true }),
		).filter((f) => basename(f) !== ".gitkeep");

		for (const file of files) {
			try {
				const content = await Bun.file(file).text();
				if (!content.trim()) continue;

				const summary = extractSummary(content, file);
				candidates.push({ source: file, summary });
			} catch {
				// skip
			}
		}
	}

	return candidates;
}

function extractSummary(content: string, filePath: string): string {
	if (filePath.endsWith("SKILL.md")) {
		const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (fmMatch?.[1]) {
			const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
			const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
			if (nameMatch?.[1] && descMatch?.[1]) {
				return `[Skill: ${nameMatch[1].trim()}] ${descMatch[1].trim()}`;
			}
		}
	}

	if (filePath.endsWith(".ts") || filePath.endsWith(".js")) {
		const jsdocMatch = content.match(/\/\*\*[\s\S]*?\*\//);
		const jsdoc = jsdocMatch?.[0] ?? "";
		const exports = content
			.split("\n")
			.filter((l) => l.startsWith("export "))
			.slice(0, 5)
			.join("\n");
		const combined = [jsdoc, exports].filter(Boolean).join("\n");
		return combined || content.slice(0, SUMMARY_MAX_CHARS);
	}

	return content.slice(0, SUMMARY_MAX_CHARS);
}

export async function ragSearch(
	query: string,
	space: SearchSpace = "all",
	paths: RagPaths,
): Promise<RagSearchResult> {
	const candidates = await collectCandidates(space, paths);

	if (candidates.length === 0) {
		return { query, space, results: [] };
	}

	const candidateList = candidates
		.map((c, i) => `[${i}] ${c.source}\n${c.summary}`)
		.join("\n---\n");

	try {
		const response = await getRuntime().client.complete({
			messages: [
				{
					role: "system",
					content: [
						"You are a retrieval assistant. Given a query and a list of candidate documents,",
						"select the documents most relevant to the query.",
						"",
						"Respond with ONLY a JSON array. Each element must have:",
						'  - "index": number (the candidate index)',
						'  - "relevance": "high" | "medium" | "low"',
						'  - "reason": string (brief explanation, 1 sentence)',
						"",
						"Only include documents that are at least somewhat relevant. If nothing is relevant, return [].",
						"Do NOT include any text outside the JSON array.",
					].join("\n"),
				},
				{
					role: "user",
					content: `## Query\n${query}\n\n## Candidates\n${candidateList}`,
				},
			],
			temperature: 0,
		});

		const text = response.text?.trim() ?? "[]";
		const selections = parseSelections(text);

		const results: RagHit[] = [];
		for (const sel of selections) {
			const candidate = candidates[sel.index];
			if (!candidate) continue;

			try {
				const fullContent = await Bun.file(candidate.source).text();
				results.push({
					source: candidate.source,
					content:
						fullContent.length > 2000
							? `${fullContent.slice(0, 2000)}\n... [truncated]`
							: fullContent,
					relevance: sel.relevance,
				});
			} catch {
				// skip
			}
		}

		return { query, space, results };
	} catch (err) {
		console.error(
			"  [ragSearch] LLM retrieval failed, falling back to keyword match:",
			err,
		);
		return keywordFallback(query, candidates);
	}
}

interface Selection {
	index: number;
	relevance: "high" | "medium" | "low";
}

function parseSelections(text: string): Selection[] {
	try {
		const jsonMatch = text.match(/\[[\s\S]*\]/);
		if (!jsonMatch) return [];

		// TODO
		// JSON.parse(...) as Array<{...}> → LLM 输出的 JSON 结构不可信，应添加运行时验证
		// 下方 item.index as number、item.relevance as "high" | "medium" | "low" 同理
		// ODOT
		const parsed = JSON.parse(jsonMatch[0]) as Array<{
			index?: number;
			relevance?: string;
		}>;

		if (!Array.isArray(parsed)) return [];

		return parsed
			.filter(
				(item) =>
					typeof item.index === "number" &&
					["high", "medium", "low"].includes(item.relevance ?? ""),
			)
			.map((item) => ({
				index: item.index as number,
				relevance: item.relevance as "high" | "medium" | "low",
			}));
	} catch {
		return [];
	}
}

async function keywordFallback(
	query: string,
	candidates: Candidate[],
): Promise<RagSearchResult> {
	const keywords = query
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length > 2);

	const hits: RagHit[] = [];

	for (const candidate of candidates) {
		const lower = candidate.summary.toLowerCase();
		const matched = keywords.some((kw) => lower.includes(kw));
		if (!matched) continue;

		try {
			const fullContent = await Bun.file(candidate.source).text();
			hits.push({
				source: candidate.source,
				content:
					fullContent.length > 2000
						? `${fullContent.slice(0, 2000)}\n... [truncated]`
						: fullContent,
				relevance: "low",
			});
		} catch {
			// skip
		}
	}

	return { query, space: "all", results: hits };
}
