/**
 * Gemini Client — Google Gemini 模型通过 OpenAI Chat Completions 兼容协议实现
 *
 * 实现 LLMClient 接口，通过原生 fetch + SSE 解析与 Gemini 兼容网关通信。
 * Gemini 的 OpenAI 兼容端点遵循标准 Chat Completions 协议：
 * - 请求格式同 OpenAI（messages + tools + stream）
 * - SSE 响应格式同 OpenAI（data: JSON chunks）
 * - 支持 function calling（tool_calls）
 *
 * Thinking 模式：
 * - 请求：注入 `reasoning_effort`（low/medium/high），思考内容通过 `delta.reasoning_content` 独立传输
 * - 响应：思考内容通过 `delta.reasoning_content` 流式传输（与 DeepSeek 格式一致）
 * - 签名：通过 `delta.provider_specific_fields.thought_signatures` 传递
 * - 多轮回传：assistant 消息中通过 reasoning_content 字段回传历史思考内容
 *
 * 缓存：Gemini 的 Context Caching 是独立 API，OpenAI 兼容端点不暴露，因此不实现 heartbeat。
 */

import { detectTagStyle, formatPrompt } from "@n0n/shared";
import type {
	CompleteRequest,
	CompleteResponse,
	LLMClient,
	PromptMessage,
	StreamEvent,
	StreamRequest,
	TagStyle,
	TokenUsage,
	ToolDefinition,
} from "@n0n/types";
import type { GoogleProviderConfig } from "./config.ts";
import { isAbortError, LLMError } from "./errors.ts";

// ── OpenAI-compatible API Types ──

interface GeminiMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	reasoning_content?: string | null;
	tool_calls?: GeminiToolCall[];
	tool_call_id?: string;
}

interface GeminiToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

interface GeminiToolDef {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

interface GeminiRequest {
	model: string;
	messages: GeminiMessage[];
	tools?: GeminiToolDef[];
	tool_choice?: "auto" | "none" | "required";
	temperature?: number;
	max_tokens?: number;
	stream?: boolean;
	stream_options?: { include_usage: boolean };
	reasoning_effort?: "low" | "medium" | "high";
}

// ── SSE Chunk Types ──

interface SSEChunk {
	choices?: Array<{
		index: number;
		delta: {
			role?: string;
			content?: string;
			reasoning_content?: string;
			provider_specific_fields?: {
				thought_signatures?: string[];
			};
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
		completion_tokens_details?: {
			reasoning_tokens?: number;
			text_tokens?: number;
		};
		prompt_tokens_details?: {
			cached_tokens?: number;
		};
	};
}

function isSSEChunk(data: unknown): data is SSEChunk {
	if (typeof data !== "object" || data === null) return false;
	const obj = data as Record<string, unknown>;
	return Array.isArray(obj.choices) || obj.usage !== undefined;
}

// ── PromptMessage → Gemini Message 转换 ──

function toGeminiMessages(promptMessages: PromptMessage[]): GeminiMessage[] {
	const result: GeminiMessage[] = [];

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
					const toolCalls: GeminiToolCall[] = msg.toolCalls.map((tc) => ({
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

function toGeminiTools(tools: ToolDefinition[]): GeminiToolDef[] {
	return tools.map((t) => ({
		type: "function" as const,
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		},
	}));
}

// ── Gemini Client ──

export class GeminiClient implements LLMClient {
	readonly modelId: string;
	readonly tagStyle: TagStyle;
	private readonly pc: GoogleProviderConfig;
	private readonly apiUrl: string;

	constructor(pc: GoogleProviderConfig) {
		this.pc = pc;
		this.modelId = this.pc.model;
		this.tagStyle = this.pc.tagStyle ?? detectTagStyle(this.modelId);

		const base = this.pc.baseUrl ?? "https://generativelanguage.googleapis.com";
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
		const promptMessages = formatPrompt(request.messages, this.modelId);
		const apiMessages = toGeminiMessages(promptMessages);

		const body: GeminiRequest = {
			model: this.modelId,
			messages: apiMessages,
			stream: true,
			stream_options: { include_usage: true },
		};

		if (request.tools?.length) {
			body.tools = toGeminiTools(request.tools);
			body.tool_choice = request.toolChoice ?? "auto";
		}

		// Gemini 始终思考，必须传 reasoning_effort 才能让 thinking 独立流式传输
		body.reasoning_effort = this.pc.thinkingEffort ?? "high";

		let res: Response;
		try {
			res = await fetch(this.apiUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.pc.apiKey}`,
				},
				body: JSON.stringify(body),
				signal,
			});
		} catch (err) {
			if (isAbortError(err)) return;
			yield {
				type: "error",
				error: err instanceof Error ? err.message : String(err),
			};
			return;
		}

		if (!res.ok) {
			const text = await res.text();
			yield { type: "error", error: `Gemini API ${res.status}: ${text}` };
			return;
		}

		if (!res.body) {
			yield {
				type: "error",
				error: "Gemini streaming response has no body",
			};
			return;
		}

		let lastUsage: TokenUsage | null = null;
		let lastFinishReason: string | null = null;

		const processDataLine = function* (
			payload: string,
		): Generator<StreamEvent> {
			if (!payload || payload === "[DONE]") return;

			let chunk: unknown;
			try {
				chunk = JSON.parse(payload);
			} catch {
				return;
			}

			if (!isSSEChunk(chunk)) return;

			if (chunk.usage) {
				const u = chunk.usage;
				const cacheReadTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
				const rawInput = u.prompt_tokens ?? 0;
				lastUsage = {
					inputTokens: rawInput - cacheReadTokens,
					outputTokens: u.completion_tokens ?? 0,
					totalTokens: u.total_tokens ?? 0,
					cacheReadTokens,
					cacheWriteTokens: 0,
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
				// Gemini 通过 provider_specific_fields.thought_signatures 传递签名
				if (delta.provider_specific_fields?.thought_signatures?.length) {
					for (const sig of delta.provider_specific_fields.thought_signatures) {
						yield { type: "thinking_signature", signature: sig };
					}
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
		};

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
								yield {
									type: "done",
									finishReason: lastFinishReason,
									usage: lastUsage,
								};
							}
							return;
						}

						yield* processDataLine(payload);
					}
					boundary = buffer.indexOf("\n\n");
				}
			}

			// Flush remaining buffer
			if (buffer.trim()) {
				for (const line of buffer.split("\n")) {
					if (!line.startsWith("data: ")) continue;
					const payload = line.slice(6);
					if (payload === "[DONE]") break;
					yield* processDataLine(payload);
				}
			}

			if (lastFinishReason) {
				yield {
					type: "done",
					finishReason: lastFinishReason,
					usage: lastUsage,
				};
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
		const messages: GeminiMessage[] = request.messages.map((m) => ({
			role: m.role,
			content: m.content,
		}));

		const body: GeminiRequest = {
			model: this.modelId,
			messages,
			stream: false,
			reasoning_effort: this.pc.thinkingEffort ?? "high",
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
						Authorization: `Bearer ${this.pc.apiKey}`,
					},
					body: JSON.stringify(body),
				});

				if (!res.ok) {
					const text = await res.text();
					if (res.status === 429 || res.status >= 500) {
						lastError = new LLMError(
							`Gemini API ${res.status}: ${text}`,
							res.status,
							text,
						);
						continue;
					}
					throw new LLMError(
						`Gemini API ${res.status}: ${text}`,
						res.status,
						text,
					);
				}

				const json = (await res.json()) as {
					choices?: Array<{
						message?: { content?: string | null };
					}>;
				};
				const text = json?.choices?.[0]?.message?.content ?? "";
				return { text };
			} catch (err) {
				if (err instanceof LLMError) throw err;
				lastError = err instanceof Error ? err : new Error(String(err));
			}
		}

		throw lastError ?? new Error("Gemini request failed after retries");
	}
}
