/**
 * LLM Client — 直接调用 OpenAI-compatible API，无 SDK 依赖
 */

import { config } from "../config.ts";
import type { LLMRequest, LLMResponse } from "../types/index.ts";

export class LLMError extends Error {
	constructor(
		message: string,
		public status: number,
		public body: unknown,
	) {
		super(message);
		this.name = "LLMError";
	}
}

/**
 * 发送 chat completion 请求
 * 包含退避重试逻辑（429/5xx）
 */
export async function chatCompletion(
	request: Omit<LLMRequest, "model">,
): Promise<LLMResponse> {
	const body: LLMRequest = {
		model: config.llm.model,
		...request,
	};

	// 无工具时不发送空数组
	if (!body.tools?.length) {
		body.tools = undefined;
		body.tool_choice = undefined;
	}

	const maxRetries = 3;
	let lastError: Error | null = null;

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		if (attempt > 0) {
			const delay = Math.min(1000 * 2 ** attempt, 10_000);
			await new Promise((r) => setTimeout(r, delay));
		}

		try {
			// 确定 endpoint 路径
			const base = config.llm.baseUrl;
			const url = base.includes("/chat/completions")
				? base
				: `${base}/v1/chat/completions`;

			const res = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${config.llm.apiKey}`,
				},
				body: JSON.stringify(body),
			});

			if (!res.ok) {
				const text = await res.text();
				// 可重试的状态码
				if (res.status === 429 || res.status >= 500) {
					lastError = new LLMError(
						`LLM API ${res.status}: ${text}`,
						res.status,
						text,
					);
					continue;
				}
				throw new LLMError(`LLM API ${res.status}: ${text}`, res.status, text);
			}

			const data = (await res.json()) as LLMResponse;
			return data;
		} catch (err) {
			if (err instanceof LLMError) {
				lastError = err;
				if (err.status !== 429 && err.status < 500) throw err;
				continue;
			}
			throw err;
		}
	}

	throw lastError ?? new Error("LLM request failed after retries");
}
