/**
 * Web Search CLI — 从命令行执行网页搜索
 *
 * 用法:
 *   bun run workflows/skills/ppio-web-search/scripts/search.ts <query> [options]
 *
 * 选项（通过环境变量或位置参数）:
 *   第1个参数: 搜索关键词（必填）
 *   --count=N         返回结果数量，默认 10
 *   --summary         启用文本摘要
 *   --freshness=VALUE 时间范围（noLimit|oneDay|oneWeek|oneMonth|oneYear）
 *   --include=DOMAIN  限定搜索域名
 *   --exclude=DOMAIN  排除搜索域名
 *
 * 示例:
 *   bun run search.ts "Bun runtime"
 *   bun run search.ts "AI news" --count=5 --summary --freshness=oneWeek
 */

import { webSearch, type SearchOptions } from "./lib.ts";

function parseArgs(argv: string[]): SearchOptions {
	const args = argv.slice(2); // skip bun + script path
	let query = "";
	const options: Partial<SearchOptions> = {};

	for (const arg of args) {
		if (arg.startsWith("--count=")) {
			options.count = Number.parseInt(arg.slice(8), 10);
		} else if (arg === "--summary") {
			options.summary = true;
		} else if (arg.startsWith("--freshness=")) {
			options.freshness = arg.slice(12);
		} else if (arg.startsWith("--include=")) {
			options.include = arg.slice(10);
		} else if (arg.startsWith("--exclude=")) {
			options.exclude = arg.slice(10);
		} else if (!arg.startsWith("--")) {
			query = query ? `${query} ${arg}` : arg;
		}
	}

	if (!query) {
		console.error("用法: bun run search.ts <query> [--count=N] [--summary] [--freshness=VALUE]");
		process.exit(1);
	}

	return { query, ...options };
}

const options = parseArgs(Bun.argv);

try {
	const result = await webSearch(options);

	const pages = result.webPages?.value ?? [];
	const images = result.images?.value ?? [];

	// 输出结构化 JSON，方便管道处理
	const output = {
		query: result.queryContext.originalQuery,
		totalWebResults: result.webPages?.totalEstimatedMatches ?? 0,
		webPages: pages.map((p) => ({
			name: p.name,
			url: p.url,
			snippet: p.snippet,
			...(p.summary ? { summary: p.summary } : {}),
			...(p.siteName ? { siteName: p.siteName } : {}),
			...(p.datePublished ? { datePublished: p.datePublished } : {}),
		})),
		...(images.length > 0
			? {
					images: images.map((img) => ({
						name: img.name,
						contentUrl: img.contentUrl,
						hostPageUrl: img.hostPageUrl,
						width: img.width,
						height: img.height,
					})),
				}
			: {}),
	};

	console.log(JSON.stringify(output, null, 2));
} catch (err) {
	console.error("搜索失败:", err instanceof Error ? err.message : err);
	process.exit(1);
}
