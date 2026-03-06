/**
 * LLM Client — 直接调用 OpenAI-compatible API，无 SDK 依赖
 */

import type { LLMRequest, LLMResponse } from "@n0n/types";
import { getLLMConfig } from "./config.ts";

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

/** 轻量结构校验 — 确保外部 API 返回的 JSON 符合 LLMResponse 基本结构 */
function isLLMResponse(data: unknown): data is LLMResponse {
	if (typeof data !== "object" || data === null) return false;
	const obj = data as Record<string, unknown>;
	return Array.isArray(obj.choices);
}

/**
 * 发送 chat completion 请求
 * 包含退避重试逻辑（429/5xx）
 */
export async function chatCompletion(
	request: Omit<LLMRequest, "model">,
): Promise<LLMResponse> {
	const config = getLLMConfig();
	const body: LLMRequest = {
		model: config.model,
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
			const base = config.baseUrl;
			const url = base.includes("/chat/completions")
				? base
				: `${base}/v1/chat/completions`;

			const res = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${config.apiKey}`,
				},
				body: JSON.stringify(body),
			});

			if (!res.ok) {
				const text = await res.text();
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

			const json: unknown = await res.json();
			if (!isLLMResponse(json)) {
				throw new LLMError(
					`LLM API returned unexpected structure: ${JSON.stringify(json).slice(0, 200)}`,
					res.status,
					json,
				);
			}
			return json;
		} catch (err) {
			if (err instanceof LLMError) throw err;
			lastError = err instanceof Error ? err : new Error(String(err));
		}
	}

	throw lastError ?? new Error("LLM request failed after retries");
}
