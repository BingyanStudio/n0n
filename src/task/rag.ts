/**
 * RAG 检索 — LLM-as-Retriever 实现
 *
 * 将所有候选文档摘要塞进 LLM context window，让 LLM 筛选最相关的条目。
 * 适用于小规模文档集（几十~几百），精度高于关键词/向量检索，零额外基础设施。
 *
 * // TODO [演进路径]
 * // 当 skill 数量增长到 context window 装不下时 → 切换为 Reranking（Cross-Encoder）全量打分
 * // 当文档数超过 reranker 可处理范围时（数千+）→ Embedding 召回 top-K + Reranking 精排
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chatCompletion } from "../llm/client.ts";
import type { LLMRequestMessage } from "../types/llm.ts";

export type SearchSpace = "all" | "memory" | "skill" | "history";

export interface RagSearchResult {
	query: string;
	space: SearchSpace;
	results: RagHit[];
}

export interface RagHit {
	source: string;
	content: string;
	relevance: "high" | "medium" | "low";
}

// ── 候选文档 ──

interface Candidate {
	/** 文件路径 */
	source: string;
	/** 摘要（用于 LLM 筛选，避免塞入全文浪费 token） */
	summary: string;
}

const SPACE_DIRS: Record<SearchSpace, string[]> = {
	skill: ["workflows/skills"],
	memory: ["workflows/memory", "workflows/consult-result"],
	history: ["workflows/history"],
	all: [
		"workflows/skills",
		"workflows/memory",
		"workflows/consult-result",
		"workflows/history",
	],
};

/** 摘要最大字符数 */
const SUMMARY_MAX_CHARS = 600;

/**
 * 扫描目录，收集所有候选文档及其摘要
 */
async function collectCandidates(space: SearchSpace): Promise<Candidate[]> {
	const dirs = SPACE_DIRS[space];
	const candidates: Candidate[] = [];

	for (const dir of dirs) {
		const absDir = resolve(dir);
		if (!existsSync(absDir)) continue;

		// 递归查找所有文件（排除 .gitkeep）
		const proc = Bun.spawnSync(
			["find", absDir, "-type", "f", "!", "-name", ".gitkeep"],
			{ stdout: "pipe" },
		);
		if (proc.exitCode !== 0) continue;

		const files = new TextDecoder()
			.decode(proc.stdout)
			.trim()
			.split("\n")
			.filter(Boolean);

		for (const file of files) {
			try {
				const content = await Bun.file(file).text();
				if (!content.trim()) continue;

				const summary = extractSummary(content, file);
				candidates.push({ source: file, summary });
			} catch {
				// 读取失败，静默跳过
			}
		}
	}

	return candidates;
}

/**
 * 从文件内容提取摘要
 * - SKILL.md：提取 frontmatter name + description
 * - .ts/.js 文件：提取 JSDoc + export 签名
 * - .md 文件：取前 N 个字符
 * - 其他：取前 N 个字符
 */
function extractSummary(content: string, filePath: string): string {
	// SKILL.md：用 frontmatter 作为摘要（比前 N 字符更精准）
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
		// 提取 JSDoc 注释
		const jsdocMatch = content.match(/\/\*\*[\s\S]*?\*\//);
		const jsdoc = jsdocMatch?.[0] ?? "";

		// 提取 export 行（函数签名、类型等）
		const exports = content
			.split("\n")
			.filter((l) => l.startsWith("export "))
			.slice(0, 5)
			.join("\n");

		const combined = [jsdoc, exports].filter(Boolean).join("\n");
		return combined || content.slice(0, SUMMARY_MAX_CHARS);
	}

	// .md 和其他文件：取前 N 个字符
	return content.slice(0, SUMMARY_MAX_CHARS);
}

/**
 * LLM-as-Retriever：让 LLM 从候选文档中筛选与 query 最相关的条目
 */
export async function ragSearch(
	query: string,
	space: SearchSpace = "all",
): Promise<RagSearchResult> {
	const candidates = await collectCandidates(space);

	// 无候选文档，直接返回空
	if (candidates.length === 0) {
		return { query, space, results: [] };
	}

	// 构建候选列表文本
	const candidateList = candidates
		.map((c, i) => `[${i}] ${c.source}\n${c.summary}`)
		.join("\n---\n");

	const messages: LLMRequestMessage[] = [
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
	];

	try {
		const response = await chatCompletion({
			messages,
			temperature: 0,
			// TODO: 当候选文档数量增长时，考虑切换为 reranker 模型以降低 token 成本
		});

		const text = response.choices[0]?.message?.content?.trim() ?? "[]";
		const selections = parseSelections(text);

		// 读取被选中文档的完整内容
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
				// 文件读取失败，跳过
			}
		}

		return { query, space, results };
	} catch (err) {
		// LLM 调用失败时降级为简单关键词匹配
		console.error(
			"  [ragSearch] LLM retrieval failed, falling back to keyword match:",
			err,
		);
		return keywordFallback(query, candidates);
	}
}

// ── 辅助函数 ──

interface Selection {
	index: number;
	relevance: "high" | "medium" | "low";
}

/**
 * 解析 LLM 返回的 JSON 选择结果
 */
function parseSelections(text: string): Selection[] {
	try {
		// 尝试提取 JSON 数组（LLM 可能包裹在 markdown code block 中）
		const jsonMatch = text.match(/\[[\s\S]*\]/);
		if (!jsonMatch) return [];

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

/**
 * 降级方案：简单关键词匹配（LLM 不可用时的兜底）
 *
 * // TODO: 当引入 reranker 后，此降级路径可替换为本地 reranker
 */
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
