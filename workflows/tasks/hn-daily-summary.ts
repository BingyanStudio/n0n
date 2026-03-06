/**
 * 每日 Hacker News 热门摘要
 *
 * 演示：定时触发 + delegateTask 组合
 * 注册方式：bun run src/main.ts schedule add hn-daily "0 8 * * *" "每日HN热门摘要"
 */

import { delegateTask } from "@n0n/core";

export default async function run() {
	const result = await delegateTask(
		"Fetch top 10 Hacker News stories using the HN API (https://hacker-news.firebaseio.com/v0/topstories.json), then generate a concise daily digest newsletter with title, URL, score for each story. Submit the formatted newsletter.",
		{ skipConsultation: true },
	);

	console.log(result.result);
	return result.result;
}
