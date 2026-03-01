/** 获取随机语录并发送到指定QQ群 */
import { readConfig, sendMessage } from "../skills/napcat-qq/scripts/lib.ts";

export default async function run() {
	const config = await readConfig();
	console.log(`Napcat配置: ${config.host}:${config.port}`);

	// 获取2条不同的随机语录
	const quotes: string[] = [];
	const seen = new Set<string>();

	while (quotes.length < 2 && seen.size < 10) {
		try {
			const res = await fetch("https://v1.hitokoto.cn/", {
				headers: {
					"User-Agent": "n0n-workflow/1.0",
					Accept: "application/json",
				},
			});
			if (!res.ok) throw new Error(`一言API错误: ${res.status}`);

			const data = (await res.json()) as {
				hitokoto: string;
				from?: string;
				from_who?: string;
			};
			let quote = data.hitokoto;
			if (data.from_who) quote += ` —— ${data.from_who}`;
			else if (data.from) quote += ` —— ${data.from}`;

			if (!seen.has(quote)) {
				seen.add(quote);
				quotes.push(quote);
			}

			if (quotes.length < 2) await new Promise((r) => setTimeout(r, 200));
		} catch (error) {
			console.error("获取语录失败:", error);
			if (quotes.length === 0) quotes.push("语录获取失败，请稍后再试");
			break;
		}
	}

	console.log("获取到的语录:", quotes);

	// 发送到群聊
	const groupId = 718824969;
	const results = [];

	for (const quote of quotes) {
		const result = await sendMessage(config, {
			action: "send_group_msg",
			params: { group_id: groupId, message: quote },
		});
		results.push({ quote, ...result });
		console.log(
			`发送${result.ok ? "成功" : "失败"}: ${quote.substring(0, 50)}...`,
		);

		// 发送间隔
		await new Promise((r) => setTimeout(r, 1000));
	}

	return { success: results.every((r) => r.ok), quotes, results, groupId };
}
