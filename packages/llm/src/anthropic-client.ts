/**
 * Anthropic Client — Anthropic Messages API 协议实现
 *
 * 实现 LLMClient 接口，通过原生 fetch + SSE 解析与 Anthropic API 通信。
 *
 * SSE 事件映射：
 * - content_block_start(type=text) + content_block_delta(text_delta) → StreamEvent.content
 * - content_block_start(type=thinking) + content_block_delta(thinking_delta) → StreamEvent.thinking
 * - content_block_start(type=tool_use) + content_block_delta(input_json_delta) → StreamEvent.tool_call_delta
 * - message_delta(stop_reason) → StreamEvent.done
 *
 * 特性：
 * - Prompt caching：单路径，通过 cache_control 注入（SSOT: cache.ts）
 * - Thinking：构造请求时注入 thinking 参数
 * - system 消息拆离（Anthropic 格式要求 system 在消息体外）
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
import { DEFAULT_THINKING_BUDGET_TOKENS } from "./config.ts";
import { LLMError, isAbortError } from "./errors.ts";

// ── Anthropic API Types ──

type AnthropicContent =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string; signature?: string }
	| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
	| { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicMessage {
	role: "user" | "assistant";
	content: string | AnthropicContent[];
}

interface AnthropicTool {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
}

interface AnthropicRequest {
	model: string;
	max_tokens: number;
	system?: string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
	messages: AnthropicMessage[];
	tools?: AnthropicTool[];
	tool_choice?: { type: "auto" | "none" | "any" };
	stream?: boolean;
	thinking?: { type: "enabled"; budget_tokens: number };
	temperature?: number;
}

// ── SSE Event Types ──

interface ContentBlockStart {
	type: "content_block_start";
	index: number;
	content_block:
		| { type: "text"; text: string }
		| { type: "thinking"; thinking: string }
		| { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
}

interface ContentBlockDelta {
	type: "content_block_delta";
	index: number;
	delta:
		| { type: "text_delta"; text: string }
		| { type: "thinking_delta"; thinking: string }
		| { type: "input_json_delta"; partial_json: string }
		| { type: "signature_delta"; signature: string };
}

interface MessageDelta {
	type: "message_delta";
	delta: {
		stop_reason: string | null;
	};
	usage?: {
		output_tokens?: number;
	};
}

interface MessageStart {
	type: "message_start";
	message?: {
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_creation_input_tokens?: number;
			cache_read_input_tokens?: number;
		};
	};
}

type AnthropicSSEEvent =
	| ContentBlockStart
	| ContentBlockDelta
	| MessageDelta
	| MessageStart
	| { type: "content_block_stop"; index: number }
	| { type: "message_stop" }
	| { type: "ping" }
	| { type: "error"; error: { type: string; message: string } };

// ── PromptMessage → Anthropic Message 转换 ──

interface AnthropicConversionResult {
	system: string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> | undefined;
	messages: AnthropicMessage[];
}

function toAnthropicFormat(
	promptMessages: PromptMessage[],
	enableCache: boolean,
): AnthropicConversionResult {
	const systemParts: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = [];
	const messages: AnthropicMessage[] = [];

	for (const msg of promptMessages) {
		switch (msg.role) {
			case "system":
				systemParts.push({ type: "text", text: msg.content });
				break;

			case "user":
				messages.push({ role: "user", content: msg.content });
				break;

			case "assistant": {
				const content: AnthropicContent[] = [];
				// 只有同时具备 reasoning 和 signature 才回传 thinking block
				// Anthropic 要求 thinking block 必须有 signature 字段
				if (msg.reasoning && msg.reasoningSignature) {
					content.push({
						type: "thinking",
						thinking: msg.reasoning,
						signature: msg.reasoningSignature,
					});
				}
				if (msg.content) {
					content.push({ type: "text", text: msg.content });
				}
				if (msg.toolCalls?.length) {
					for (const tc of msg.toolCalls) {
						content.push({
							type: "tool_use",
							id: tc.id,
							name: tc.tool,
							input: tc.args,
						});
					}
				}
				if (content.length === 0) {
					content.push({ type: "text", text: "" });
				}
				messages.push({ role: "assistant", content });
				break;
			}

			case "tool":
				messages.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: msg.toolCallId,
							content: msg.content,
						},
					],
				});
				break;
		}
	}

	// Prompt caching: 注入 cache_control
	if (enableCache) {
		// System 部分：最后一个 system block 加 cache
		let cacheCount = 0;
		if (systemParts.length > 0) {
			systemParts[systemParts.length - 1]!.cache_control = { type: "ephemeral" };
			cacheCount++;
		}

		// Messages 部分：使用 selectCacheBreakpoints 选择断点
		// Anthropic 限制最多 4 个 cache_control，减去 system 已用的配额
		const maxMessageBreakpoints = 4 - cacheCount;
		const breakpoints = selectCacheBreakpoints(messages).slice(0, maxMessageBreakpoints);
		for (const idx of breakpoints) {
			const msg = messages[idx];
			if (!msg) continue;
			if (typeof msg.content === "string") {
				// 转为 content block 以注入 cache_control
				messages[idx] = {
					role: msg.role,
					content: [
						{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } } as unknown as AnthropicContent,
					],
				};
			} else if (Array.isArray(msg.content) && msg.content.length > 0) {
				const lastBlock = msg.content[msg.content.length - 1]!;
				(lastBlock as unknown as Record<string, unknown>).cache_control = {
					type: "ephemeral",
				};
			}
		}
	}

	const system =
		systemParts.length === 0
			? undefined
			: systemParts.length === 1 && !systemParts[0]?.cache_control
				? systemParts[0]!.text
				: systemParts;

	return { system, messages };
}

function toAnthropicTools(tools: ToolDefinition[]): AnthropicTool[] {
	return tools.map((t) => ({
		name: t.name,
		description: t.description,
		input_schema: t.parameters,
	}));
}

// ── Anthropic Client ──

export class AnthropicClient implements LLMClient {
	readonly modelId: string;
	private readonly config: LLMConfig;
	private readonly apiUrl: string;

	constructor(config: LLMConfig) {
		this.config = config;
		this.modelId = config.providerConfig.model;

		const pc = config.providerConfig;
		const base =
			("baseUrl" in pc && pc.baseUrl) ? pc.baseUrl : "https://api.anthropic.com";
		// 处理 baseUrl 可能已包含 /v1 的情况（如代理 URL）
		const cleanBase = base.replace(/\/v1\/?$/, "").replace(/\/$/, "");
		this.apiUrl = `${cleanBase}/v1/messages`;
	}

	async *stream(
		request: StreamRequest,
		signal?: AbortSignal,
	): AsyncGenerator<StreamEvent> {
		const promptMessages = request.promptMessages
			?? formatPrompt(request.messages, this.modelId);
		const { system, messages } = toAnthropicFormat(promptMessages, true);

		const defaultMaxTokens = this.config.maxOutputTokens ?? 8192;
		const body: AnthropicRequest = {
			model: this.modelId,
			max_tokens: defaultMaxTokens,
			system,
			messages,
			stream: true,
		};

		if (request.tools?.length) {
			body.tools = toAnthropicTools(request.tools);
			const tc = request.toolChoice ?? "auto";
			body.tool_choice = { type: tc === "required" ? "any" : tc };
		}

		if (this.config.enableThinking) {
			const budget =
				this.config.thinkingBudgetTokens ?? DEFAULT_THINKING_BUDGET_TOKENS;
			body.thinking = { type: "enabled", budget_tokens: budget };
			body.max_tokens = Math.max(defaultMaxTokens, budget + 4096);
			// Anthropic requires temperature=1 when thinking is enabled
			body.temperature = 1;
		}

		let res: Response;
		try {
			res = await fetch(this.apiUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": this.config.providerConfig.apiKey,
					"anthropic-version": "2023-06-01",
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
			yield { type: "error", error: `Anthropic API ${res.status}: ${text}` };
			return;
		}

		if (!res.body) {
			yield { type: "error", error: "Anthropic streaming response has no body" };
			return;
		}

		// Track tool_use blocks by SSE index → sequential tool call index
		const toolBlocks = new Map<number, { id: string; name: string; idx: number }>();
		let toolCallIndex = 0;
		let inputUsage: TokenUsage | null = null;

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

					// Parse SSE event
					let eventType = "";
					let eventData = "";
					for (const line of raw.split("\n")) {
						if (line.startsWith("event: ")) {
							eventType = line.slice(7);
						} else if (line.startsWith("data: ")) {
							eventData = line.slice(6);
						}
					}

					if (!eventData) {
						boundary = buffer.indexOf("\n\n");
						continue;
					}

					let event: AnthropicSSEEvent;
					try {
						event = JSON.parse(eventData) as AnthropicSSEEvent;
					} catch {
						boundary = buffer.indexOf("\n\n");
						continue;
					}

					switch (event.type) {
						case "message_start": {
							const u = event.message?.usage;
							if (u) {
								inputUsage = {
									inputTokens: u.input_tokens ?? 0,
									outputTokens: u.output_tokens ?? 0,
									totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
									cacheReadTokens: u.cache_read_input_tokens ?? 0,
									cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
								};
							}
							break;
						}

						case "content_block_start": {
							const block = event.content_block;
							if (block.type === "text" && block.text) {
								yield { type: "content", text: block.text };
							} else if (block.type === "thinking" && block.thinking) {
								yield { type: "thinking", text: block.thinking };
							} else if (block.type === "tool_use") {
								const idx = toolCallIndex++;
								toolBlocks.set(event.index, {
									id: block.id,
									name: block.name,
									idx,
								});
								yield {
									type: "tool_call_delta",
									index: idx,
									id: block.id,
									name: block.name,
									arguments: "",
								};
							}
							break;
						}

						case "content_block_delta": {
							const delta = event.delta;
							if (delta.type === "text_delta") {
								yield { type: "content", text: delta.text };
							} else if (delta.type === "thinking_delta") {
								yield { type: "thinking", text: delta.thinking };
							} else if (delta.type === "input_json_delta") {
								const tb = toolBlocks.get(event.index);
								yield {
									type: "tool_call_delta",
									index: tb?.idx ?? event.index,
									id: tb?.id,
									name: undefined,
									arguments: delta.partial_json,
								};
							} else if (delta.type === "signature_delta") {
								yield { type: "thinking_signature", signature: delta.signature };
							}
							break;
						}

						case "message_delta": {
							const stopReason = event.delta.stop_reason ?? "stop";
							const outputTokens = event.usage?.output_tokens ?? 0;
							const usage: TokenUsage | null = inputUsage
								? {
										...inputUsage,
										outputTokens:
											inputUsage.outputTokens + outputTokens,
										totalTokens:
											inputUsage.inputTokens + inputUsage.outputTokens + outputTokens,
									}
								: null;
							yield {
								type: "done",
								finishReason:
									stopReason === "end_turn"
										? "stop"
										: stopReason === "max_tokens"
											? "length"
											: stopReason === "tool_use"
												? "tool_calls"
												: stopReason,
								usage,
							};
							break;
						}

						case "error":
							yield {
								type: "error",
								error: `Anthropic error: ${event.error.type}: ${event.error.message}`,
							};
							break;
					}

					boundary = buffer.indexOf("\n\n");
				}
			}

			// Flush remaining buffer — handle case where stream ends without trailing \n\n
			if (buffer.trim()) {
				let eventData = "";
				for (const line of buffer.split("\n")) {
					if (line.startsWith("event: ")) {
						// skip event type line
					} else if (line.startsWith("data: ")) {
						eventData = line.slice(6);
					}
				}
				if (eventData) {
					try {
						const event = JSON.parse(eventData) as AnthropicSSEEvent;
						if (event.type === "message_delta") {
							const stopReason = event.delta.stop_reason ?? "stop";
							const outputTokens = event.usage?.output_tokens ?? 0;
							const usage: TokenUsage | null = inputUsage
								? {
										...inputUsage,
										outputTokens: inputUsage.outputTokens + outputTokens,
										totalTokens: inputUsage.inputTokens + inputUsage.outputTokens + outputTokens,
									}
								: null;
							yield {
								type: "done",
								finishReason:
									stopReason === "end_turn"
										? "stop"
										: stopReason === "max_tokens"
											? "length"
											: stopReason === "tool_use"
												? "tool_calls"
												: stopReason,
								usage,
							};
						}
					} catch {
						// ignore parse errors in residual buffer
					}
				}
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
		const messages: AnthropicMessage[] = [];
		let system = "";

		for (const m of request.messages) {
			if (m.role === "system") {
				system += (system ? "\n\n" : "") + m.content;
			} else {
				messages.push({ role: "user", content: m.content });
			}
		}

		const body: AnthropicRequest = {
			model: this.modelId,
			max_tokens: this.config.maxOutputTokens ?? 4096,
			system,
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
						"x-api-key": this.config.providerConfig.apiKey,
						"anthropic-version": "2023-06-01",
					},
					body: JSON.stringify(body),
				});

				if (!res.ok) {
					const text = await res.text();
					if (res.status === 429 || res.status >= 500) {
						lastError = new LLMError(
							`Anthropic API ${res.status}: ${text}`,
							res.status,
							text,
						);
						continue;
					}
					throw new LLMError(
						`Anthropic API ${res.status}: ${text}`,
						res.status,
						text,
					);
				}

				const json = (await res.json()) as {
					content?: Array<{ type: string; text?: string }>;
				};
				const textBlock = json?.content?.find((b) => b.type === "text");
				return { text: textBlock?.text ?? "" };
			} catch (err) {
				if (err instanceof LLMError) throw err;
				lastError = err instanceof Error ? err : new Error(String(err));
			}
		}

		throw lastError ?? new Error("Anthropic request failed after retries");
	}
}
