/**
 * RAG 检索 — MVP 实现
 *
 * MVP 阶段使用文件系统 grep 进行简单的关键词检索。
 * 后续可替换为向量数据库。
 */

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

const SPACE_DIRS: Record<SearchSpace, string[]> = {
	skill: ["workflows/skills"],
	memory: ["workflows/memory"],
	history: ["workflows/history"],
	all: ["workflows/skills", "workflows/memory", "workflows/history"],
};

/**
 * MVP RAG: 使用 grep 在对应目录下搜索关键词
 */
export async function ragSearch(
	query: string,
	space: SearchSpace = "all",
): Promise<RagSearchResult> {
	const dirs = SPACE_DIRS[space];
	const hits: RagHit[] = [];

	// 提取关键词（简单分词）
	const keywords = query
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length > 2);

	for (const dir of dirs) {
		try {
			// 检查目录是否存在
			const dirCheck = Bun.spawnSync(["test", "-d", dir]);
			if (dirCheck.exitCode !== 0) continue;

			// grep 搜索
			for (const keyword of keywords) {
				const proc = Bun.spawnSync(["grep", "-rl", "-i", keyword, dir], {
					stdout: "pipe",
					stderr: "pipe",
				});

				if (proc.exitCode !== 0) continue;

				const files = new TextDecoder()
					.decode(proc.stdout)
					.trim()
					.split("\n")
					.filter(Boolean);

				for (const file of files) {
					// 避免重复
					if (hits.some((h) => h.source === file)) continue;

					const content = await Bun.file(file).text();
					// 截取相关片段（前2000字符）
					hits.push({
						source: file,
						content:
							content.length > 2000
								? `${content.slice(0, 2000)}\n... [truncated]`
								: content,
						relevance: space === "history" ? "low" : "medium",
					});
				}
			}
		} catch {
			// 目录不存在等情况，静默跳过
		}
	}

	return { query, space, results: hits };
}
