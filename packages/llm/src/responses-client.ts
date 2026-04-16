/**
 * OpenAI Responses API 的轻量客户端工厂
 *
 * 将 baseUrl / apiKey / model 闭包在返回的 ResponsesClient 中，
 * 消费方（FreeformPatchBackend）只依赖最小的 create() 接口。
 */

import type { ResponsesClient } from "@n0n/tools";

export interface ResponsesClientConfig {
	baseUrl: string;
	apiKey: string;
	model: string;
}

export function createResponsesClient(
	config: ResponsesClientConfig,
): ResponsesClient {
	const base = config.baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
	const apiUrl = `${base}/v1/responses`;

	return {
		async create(input, tools, signal) {
			let res: Response;
			try {
				res = await fetch(apiUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${config.apiKey}`,
					},
					body: JSON.stringify({ model: config.model, input, tools }),
					signal,
				});
			} catch (err) {
				if (signal?.aborted) return { error: "Aborted" };
				return {
					error: `Fetch: ${err instanceof Error ? err.message : String(err)}`,
				};
			}

			if (!res.ok) {
				const text = await res.text();
				return { error: `API ${res.status}: ${text.slice(0, 300)}` };
			}

			return (await res.json()) as {
				output: {
					type: string;
					call_id?: string;
					name?: string;
					input?: string;
				}[];
			};
		},
	};
}
