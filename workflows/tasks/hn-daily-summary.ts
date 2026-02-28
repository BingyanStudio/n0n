/**
 * 每日 Hacker News 热门摘要
 *
 * 演示：定时触发 + subagent + skill 组合
 * 注册方式：bun run src/main.ts schedule add hn-daily "0 8 * * *" "Summarize today's top Hacker News stories and email the report"
 */

import { subagent } from "../../src/index.ts";

export default async function run() {
	// Step 1: 抓取 HN 热门
	const fetchResult = await subagent(
		[
			"Fetch the current top 10 stories from Hacker News using their API.",
			"Use `exec` to run curl commands:",
			"  curl -s https://hacker-news.firebaseio.com/v0/topstories.json",
			"Then fetch details for the top 10 story IDs.",
			"Submit a JSON array of objects with fields: title, url, score, by.",
		].join("\n"),
		{ maxIterations: 20 },
	);

	// Step 2: 生成摘要
	const summaryResult = await subagent(
		[
			"Based on the following Hacker News stories, write a concise daily digest email.",
			"Format it as a professional newsletter with brief descriptions.",
			"",
			"Stories:",
			JSON.stringify(fetchResult.result, null, 2),
			"",
			"Submit the formatted email body as your result.",
		].join("\n"),
		{ maxIterations: 10 },
	);

	return summaryResult.result;
}
