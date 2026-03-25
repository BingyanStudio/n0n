/**
 * OpenAI Client — OpenAI Chat Completions 协议实现
 *
 * 实现 LLMClient 接口，通过原生 fetch + SSE 解析与 OpenAI-compatible API 通信。
 * 从 git 3892541~1 恢复 SSE 解析核心，增强：
 * - finishReason 传递到 StreamEvent.done
 * - delta.reasoning_content 处理（国产模型支持）
 * - error 事件：SSE 解析错误 → yield { type: "error" }
 * - token usage 统计
 *
 * 同时处理 openai-compatible provider（如 DeepSeek、litellm 代理）。
 */

import { formatPrompt } from "@n0n/shared";
import type {
	CompleteRequest,
	CompleteResponse,
	LLMClient,
	PromptMessage,
	StreamEvent,
	StreamRequest,
	TokenUsage,
	ToolDefinition,
} from "@n0n/types";
import { selectCacheBreakpoints } from "./cache.ts";
import type { LLMConfig } from "./config.ts";
import { LLMError, isAbortError } from "./errors.ts";

// ── OpenAI API Types ──

interface OpenAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	reasoning_content?: string | null;
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
}

interface OpenAIToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

interface OpenAIToolDef {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

interface OpenAIRequest {
	model: string;
	messages: OpenAIMessage[];
	tools?: OpenAIToolDef[];
	tool_choice?: "auto" | "none" | "required";
	temperature?: number;
	max_tokens?: number;
	stream?: boolean;
	stream_options?: { include_usage: boolean };
	enable_thinking?: boolean;
}

// ── SSE Chunk Types ──

interface SSEChunk {
	choices?: Array<{
		index: number;
		delta: {
			role?: string;
			content?: string;
			reasoning_content?: string;
			tool_calls?: Array<{
				index: number;
				id?: string;
				type?: string;
				function?: {
					name?: string;
					arguments?: string;
				};
			}>;
		};
		finish_reason: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		prompt_tokens_details?: {
			cached_tokens?: number;
		};
		prompt_cache_hit_tokens?: number;
		prompt_cache_miss_tokens?: number;
	};
}

function isSSEChunk(data: unknown): data is SSEChunk {
	if (typeof data !== "object" || data === null) return false;
	const obj = data as Record<string, unknown>;
	return Array.isArray(obj.choices) || obj.usage !== undefined;
}

// ── PromptMessage → OpenAI Message 转换 ──

function toOpenAIMessages(promptMessages: PromptMessage[]): OpenAIMessage[] {
	const result: OpenAIMessage[] = [];

	for (const msg of promptMessages) {
		switch (msg.role) {
			case "system":
				result.push({ role: "system", content: msg.content });
				break;

			case "user":
				result.push({ role: "user", content: msg.content });
				break;

			case "assistant": {
				if (msg.toolCalls?.length) {
					const toolCalls: OpenAIToolCall[] = msg.toolCalls.map((tc) => ({
						id: tc.id,
						type: "function" as const,
						function: {
							name: tc.tool,
							arguments: JSON.stringify(tc.args),
						},
					}));
					result.push({
						role: "assistant",
						content: msg.content || null,
						reasoning_content: msg.reasoning ?? undefined,
						tool_calls: toolCalls,
					});
				} else {
					result.push({
						role: "assistant",
						content: msg.content || null,
						reasoning_content: msg.reasoning ?? undefined,
					});
				}
				break;
			}

			case "tool":
				result.push({
					role: "tool",
					content: msg.content,
					tool_call_id: msg.toolCallId,
				});
				break;
		}
	}

	return result;
}

function toOpenAITools(tools: ToolDefinition[]): OpenAIToolDef[] {
	return tools.map((t) => ({
		type: "function" as const,
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		},
	}));
}

// ── OpenAI Client ──

export class OpenAIClient implements LLMClient {
	readonly modelId: string;
	private readonly config: LLMConfig;
	private readonly apiUrl: string;

	constructor(config: LLMConfig) {
		this.config = config;
		this.modelId = config.providerConfig.model;

		const pc = config.providerConfig;
		const base =
			("baseUrl" in pc && pc.baseUrl) ? pc.baseUrl : "https://api.openai.com";
		// 处理 baseUrl 可能已包含 /v1 或完整路径的情况
		if (base.includes("/chat/completions")) {
			this.apiUrl = base;
		} else {
			const cleanBase = base.replace(/\/v1\/?$/, "").replace(/\/$/, "");
			this.apiUrl = `${cleanBase}/v1/chat/completions`;
		}
	}

	async *stream(
		request: StreamRequest,
		signal?: AbortSignal,
	): AsyncGenerator<StreamEvent> {
		const promptMessages = request.promptMessages
			?? formatPrompt(request.messages, this.modelId);
		const apiMessages = toOpenAIMessages(promptMessages);

		// 如果后端是 anthropic（通过 litellm），注入 cache_control
		// Anthropic 限制最多 4 个 cache_control 断点，selectCacheBreakpoints 已保证 ≤ 4
		if (
			this.config.providerConfig.provider === "openai-compatible" &&
			this.config.providerConfig.backendProvider === "anthropic"
		) {
			const breakpoints = selectCacheBreakpoints(apiMessages).slice(0, 4);
			for (const idx of breakpoints) {
				const msg = apiMessages[idx];
				if (msg) {
					(msg as unknown as Record<string, unknown>).cache_control = {
						type: "ephemeral",
					};
				}
			}
		}

		const body: OpenAIRequest = {
			model: this.modelId,
			messages: apiMessages,
			stream: true,
			stream_options: { include_usage: true },
		};

		if (request.tools?.length) {
			body.tools = toOpenAITools(request.tools);
			body.tool_choice = request.toolChoice ?? "auto";
		}

		if (this.config.enableThinking) {
			body.enable_thinking = true;
		}

		let res: Response;
		try {
			res = await fetch(this.apiUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.config.providerConfig.apiKey}`,
				},
				body: JSON.stringify(body),
				signal,
			});
		} catch (err) {
			if (isAbortError(err)) return;
			yield { type: "error", error: err instanceof Error ? err.message : String(err) };
			return;
		}

		if (!res.ok) {
			const text = await res.text();
			yield { type: "error", error: `LLM API ${res.status}: ${text}` };
			return;
		}

		if (!res.body) {
			yield { type: "error", error: "LLM streaming response has no body" };
			return;
		}

		let lastUsage: TokenUsage | null = null;
		let lastFinishReason: string | null = null;

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				let boundary = buffer.indexOf("\n\n");
				while (boundary !== -1) {
					const raw = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary + 2);

					for (const line of raw.split("\n")) {
						if (!line.startsWith("data: ")) continue;
						const payload = line.slice(6);

						if (payload === "[DONE]") {
							if (lastFinishReason) {
								yield { type: "done", finishReason: lastFinishReason, usage: lastUsage };
							}
							return;
						}

						let chunk: unknown;
						try {
							chunk = JSON.parse(payload);
						} catch {
							continue;
						}

						if (!isSSEChunk(chunk)) continue;

						// usage 统计（部分 provider 在最后一个 chunk 发送 usage）
						if (chunk.usage) {
							const u = chunk.usage;
							lastUsage = {
								inputTokens: u.prompt_tokens ?? 0,
								outputTokens: u.completion_tokens ?? 0,
								totalTokens: u.total_tokens ?? 0,
								cacheReadTokens:
									u.prompt_tokens_details?.cached_tokens ??
									u.prompt_cache_hit_tokens ??
									0,
								cacheWriteTokens: u.prompt_cache_miss_tokens ?? 0,
							};
						}

						const delta = chunk.choices?.[0]?.delta;
						if (!delta) continue;

						if (delta.reasoning_content) {
							yield {
								type: "thinking",
								text: delta.reasoning_content,
							};
						}

						if (delta.content) {
							yield { type: "content", text: delta.content };
						}

						if (delta.tool_calls) {
							for (const tc of delta.tool_calls) {
								yield {
									type: "tool_call_delta",
									index: tc.index,
									id: tc.id,
									name: tc.function?.name,
									arguments: tc.function?.arguments ?? "",
								};
							}
						}

						const finish = chunk.choices?.[0]?.finish_reason;
						if (finish) {
							lastFinishReason = finish;
						}
					}
					boundary = buffer.indexOf("\n\n");
				}
			}

			// Flush remaining buffer — handle case where stream ends without trailing \n\n
			if (buffer.trim()) {
				for (const line of buffer.split("\n")) {
					if (!line.startsWith("data: ")) continue;
					const payload = line.slice(6);
					if (payload === "[DONE]") break;
					let chunk: unknown;
					try {
						chunk = JSON.parse(payload);
					} catch {
						continue;
					}
					if (!isSSEChunk(chunk)) continue;
					if (chunk.usage) {
						const u = chunk.usage;
						lastUsage = {
							inputTokens: u.prompt_tokens ?? 0,
							outputTokens: u.completion_tokens ?? 0,
							totalTokens: u.total_tokens ?? 0,
							cacheReadTokens:
								u.prompt_tokens_details?.cached_tokens ??
								u.prompt_cache_hit_tokens ??
								0,
							cacheWriteTokens: u.prompt_cache_miss_tokens ?? 0,
						};
					}
					const delta = chunk.choices?.[0]?.delta;
					if (delta) {
						if (delta.reasoning_content) {
							yield { type: "thinking", text: delta.reasoning_content };
						}
						if (delta.content) {
							yield { type: "content", text: delta.content };
						}
						if (delta.tool_calls) {
							for (const tc of delta.tool_calls) {
								yield {
									type: "tool_call_delta",
									index: tc.index,
									id: tc.id,
									name: tc.function?.name,
									arguments: tc.function?.arguments ?? "",
								};
							}
						}
					}
					const finish = chunk.choices?.[0]?.finish_reason;
					if (finish) {
						lastFinishReason = finish;
					}
				}
			}

			// If stream ended without [DONE], emit deferred done event
			if (lastFinishReason) {
				yield { type: "done", finishReason: lastFinishReason, usage: lastUsage };
			}
		} catch (err) {
			if (!isAbortError(err)) {
				yield {
					type: "error",
					error: err instanceof Error ? err.message : String(err),
				};
			}
		} finally {
			reader.releaseLock();
		}
	}

	async complete(request: CompleteRequest): Promise<CompleteResponse> {
		const messages: OpenAIMessage[] = request.messages.map((m) => ({
			role: m.role,
			content: m.content,
		}));

		const body: OpenAIRequest = {
			model: this.modelId,
			messages,
			stream: false,
		};

		if (request.temperature !== undefined) {
			body.temperature = request.temperature;
		}

		const maxRetries = 3;
		let lastError: Error | null = null;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			if (attempt > 0) {
				const delay = Math.min(1000 * 2 ** attempt, 10_000);
				await new Promise((r) => setTimeout(r, delay));
			}

			try {
				const res = await fetch(this.apiUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${this.config.providerConfig.apiKey}`,
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
					throw new LLMError(
						`LLM API ${res.status}: ${text}`,
						res.status,
						text,
					);
				}

				const json = (await res.json()) as {
					choices?: Array<{
						message?: { content?: string | null };
					}>;
				};
				const text =
					json?.choices?.[0]?.message?.content ?? "";
				return { text };
			} catch (err) {
				if (err instanceof LLMError) throw err;
				lastError =
					err instanceof Error ? err : new Error(String(err));
			}
		}

		throw lastError ?? new Error("LLM request failed after retries");
	}
}
