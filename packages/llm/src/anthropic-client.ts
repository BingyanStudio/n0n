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
 * - Prompt caching：支持两种模式
 *   - 显式断点：DomainMessage 中的 cache_breakpoint 标记转换为 content block 级 cache_control
 *   - 自动缓存：请求顶层 cache_control（Anthropic 20 块回溯窗口），始终启用作为末尾兜底
 * - Thinking：构造请求时注入 thinking 参数
 * - system 消息拆离（Anthropic 格式要求 system 在消息体外）
 */

import { createTagAdapter, detectTagStyle, formatPrompt } from "@n0n/shared";
import {
	type CompleteRequest,
	type CompleteResponse,
	FinishReason,
	type LLMClient,
	type PromptMessage,
	type StreamEvent,
	type StreamRequest,
	type TagAdapter,
	type TagStyle,
	type TokenUsage,
	type ToolDefinition,
} from "@n0n/types";
import type { AnthropicProviderConfig } from "./config.ts";
import { isAbortError, LLMError } from "./errors.ts";

// ── Anthropic 默认常量 ──

/** stream() 默认最大输出 token 数 */
const DEFAULT_STREAM_MAX_TOKENS = 8192;
/** complete() 默认最大输出 token 数 */
const DEFAULT_COMPLETE_MAX_TOKENS = 4096;
/** thinking 模式下输出 token 的额外 buffer（Anthropic 要求 max_tokens > budget_tokens） */
const THINKING_OUTPUT_BUFFER = 4096;

// ── Anthropic API Types ──

type AnthropicContent =
	| { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
	| { type: "thinking"; thinking: string; signature?: string }
	| {
			type: "tool_use";
			id: string;
			name: string;
			input: Record<string, unknown>;
			cache_control?: { type: "ephemeral" };
	  }
	| {
			type: "tool_result";
			tool_use_id: string;
			content: string;
			cache_control?: { type: "ephemeral" };
	  };

interface AnthropicMessage {
	role: "user" | "assistant";
	content: string | AnthropicContent[];
}

interface AnthropicTool {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
	/** 启用细粒度工具流式传输 — 跳过服务端 JSON 缓冲验证，直接流式发送参数 */
	eager_input_streaming?: boolean;
}

interface AnthropicRequest {
	model: string;
	max_tokens: number;
	system?:
		| string
		| Array<{
				type: "text";
				text: string;
				cache_control?: { type: "ephemeral" };
		  }>;
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
		| {
				type: "tool_use";
				id: string;
				name: string;
				input: Record<string, unknown>;
		  };
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
	system:
		| string
		| Array<{
				type: "text";
				text: string;
				cache_control?: { type: "ephemeral" };
		  }>
		| undefined;
	messages: AnthropicMessage[];
	/** 消息中是否包含显式缓存断点标记 */
	hasExplicitBreakpoints: boolean;
}

function toAnthropicFormat(
	promptMessages: PromptMessage[],
): AnthropicConversionResult {
	const systemParts: Array<{
		type: "text";
		text: string;
		cache_control?: { type: "ephemeral" };
	}> = [];
	const messages: AnthropicMessage[] = [];
	let hasBreakpoint = false;

	for (const msg of promptMessages) {
		switch (msg.role) {
			case "system": {
				const part: (typeof systemParts)[number] = {
					type: "text",
					text: msg.content,
				};
				if (msg.cacheBreakpoint) {
					part.cache_control = { type: "ephemeral" };
					hasBreakpoint = true;
				}
				systemParts.push(part);
				break;
			}

			case "user":
				if (msg.cacheBreakpoint) {
					messages.push({
						role: "user",
						content: [
							{
								type: "text",
								text: msg.content,
								cache_control: { type: "ephemeral" },
							},
						],
					});
					hasBreakpoint = true;
				} else {
					messages.push({
						role: "user",
						content: msg.content,
					});
				}
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
				if (msg.cacheBreakpoint) {
					for (let i = content.length - 1; i >= 0; i--) {
						const block = content[i];
						if (
							block &&
							(block.type === "text" ||
								block.type === "tool_result" ||
								block.type === "tool_use")
						) {
							block.cache_control = { type: "ephemeral" };
							break;
						}
					}
					hasBreakpoint = true;
				}
				messages.push({ role: "assistant", content });
				break;
			}

			case "tool": {
				const toolResultBlock: AnthropicContent = {
					type: "tool_result",
					tool_use_id: msg.toolCallId,
					content: msg.content,
				};
				if (msg.cacheBreakpoint) {
					toolResultBlock.cache_control = { type: "ephemeral" };
					hasBreakpoint = true;
				}
				messages.push({
					role: "user",
					content: [toolResultBlock],
				});
				break;
			}
		}
	}

	let autoBreakpointSet = false;
	if (!autoBreakpointSet) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (!msg) continue;

			if (typeof msg.content === "string") {
				msg.content = [
					{
						type: "text",
						text: msg.content,
						cache_control: { type: "ephemeral" },
					},
				];
				autoBreakpointSet = true;
				break;
			}

			if (Array.isArray(msg.content) && msg.content.length > 0) {
				for (let j = msg.content.length - 1; j >= 0; j--) {
					const block = msg.content[j];
					if (
						block &&
						(block.type === "text" ||
							block.type === "tool_result" ||
							block.type === "tool_use")
					) {
						block.cache_control = { type: "ephemeral" };
						autoBreakpointSet = true;
						break;
					}
				}
				if (autoBreakpointSet) break;
			}
		}

		if (!autoBreakpointSet && messages.length === 0 && systemParts.length > 0) {
			for (let i = systemParts.length - 1; i >= 0; i--) {
				const part = systemParts[i];
				if (part) {
					part.cache_control = { type: "ephemeral" };
					autoBreakpointSet = true;
					break;
				}
			}
		}
	}
	// 有 cache_control 标记时必须使用数组形式（字符串形式不支持 cache_control）
	const hasSystemBreakpoint = systemParts.some((p) => p.cache_control);
	const system =
		systemParts.length === 0
			? undefined
			: systemParts.length === 1 && !hasSystemBreakpoint
				? systemParts[0]?.text
				: systemParts;

	return { system, messages, hasExplicitBreakpoints: hasBreakpoint };
}

function toAnthropicTools(tools: ToolDefinition[]): AnthropicTool[] {
	return tools.map((t) => ({
		name: t.name,
		description: t.description,
		input_schema: t.parameters,
		// Anthropic 默认会缓冲工具参数 JSON 直到验证完整后才发送 SSE 事件，
		// 导致长参数（如 write 的 content）出现 10s+ 的等待后一次性涌出。
		// 启用 eager_input_streaming 跳过服务端缓冲，实现真正的逐 token 流式传输。
		eager_input_streaming: true,
	}));
}

// ── Anthropic Client ──

export class AnthropicClient implements LLMClient {
	readonly modelId: string;
	readonly tagStyle: TagStyle;
	readonly tags: TagAdapter;
	private readonly pc: AnthropicProviderConfig;
	private readonly apiUrl: string;

	constructor(pc: AnthropicProviderConfig) {
		this.pc = pc;
		this.modelId = this.pc.model;
		this.tagStyle = this.pc.tagStyle ?? detectTagStyle(this.modelId);
		this.tags = createTagAdapter(this.tagStyle);

		const base = this.pc.baseUrl ?? "https://api.anthropic.com";
		// 处理 baseUrl 可能已包含 /v1 的情况（如代理 URL）
		const cleanBase = base.replace(/\/v1\/?$/, "").replace(/\/$/, "");
		this.apiUrl = `${cleanBase}/v1/messages`;
	}

	async *stream(
		request: StreamRequest,
		signal?: AbortSignal,
	): AsyncGenerator<StreamEvent> {
		const promptMessages = formatPrompt(request.messages, this.tags);
		const { system, messages } = toAnthropicFormat(promptMessages);

		const body: AnthropicRequest = {
			model: this.modelId,
			max_tokens: DEFAULT_STREAM_MAX_TOKENS,
			system,
			messages,
			stream: true,
		};

		if (request.tools?.length) {
			body.tools = toAnthropicTools(request.tools);
			const tc = request.toolChoice ?? "auto";
			body.tool_choice = { type: tc === "required" ? "any" : tc };
		}

		if (this.pc.thinking) {
			const budget = this.pc.thinking.budgetTokens;
			body.thinking = { type: "enabled", budget_tokens: budget };
			body.max_tokens = Math.max(
				DEFAULT_STREAM_MAX_TOKENS,
				budget + THINKING_OUTPUT_BUFFER,
			);
			// Anthropic requires temperature=1 when thinking is enabled
			body.temperature = 1;
		}

		let res: Response;
		try {
			res = await fetch(this.apiUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": this.pc.apiKey,
					"anthropic-version": "2023-06-01",
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
			yield { type: "error", error: `Anthropic API ${res.status}: ${text}` };
			return;
		}

		if (!res.body) {
			yield {
				type: "error",
				error: "Anthropic streaming response has no body",
			};
			return;
		}

		// Track tool_use blocks by SSE index → sequential tool call index
		const toolBlocks = new Map<
			number,
			{ id: string; name: string; idx: number }
		>();
		let toolCallIndex = 0;
		let inputUsage: TokenUsage | null = null;

		// 内部函数：将 Anthropic stop_reason 映射为归一化的 done 事件（#009）
		const mapMessageDelta = function* (
			event: MessageDelta,
		): Generator<StreamEvent> {
			const stopReason = event.delta.stop_reason ?? "stop";
			const outputTokens = event.usage?.output_tokens ?? 0;
			const usage: TokenUsage | null = inputUsage
				? {
						...inputUsage,
						outputTokens: inputUsage.outputTokens + outputTokens,
						totalTokens:
							inputUsage.inputTokens + inputUsage.outputTokens + outputTokens,
					}
				: null;
			yield {
				type: "done",
				finishReason:
					stopReason === "end_turn"
						? FinishReason.STOP
						: stopReason === "max_tokens"
							? FinishReason.LENGTH
							: stopReason === "tool_use"
								? FinishReason.TOOL_CALLS
								: stopReason,
				usage,
			};
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

					// Parse SSE event
					let _eventType = "";
					let eventData = "";
					for (const line of raw.split("\n")) {
						if (line.startsWith("event: ")) {
							_eventType = line.slice(7);
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
						// catch 处理解析失败，switch(event.type) 验证结构
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
								yield {
									type: "thinking_signature",
									signature: delta.signature,
								};
							}
							break;
						}

						case "message_delta": {
							yield* mapMessageDelta(event);
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
							yield* mapMessageDelta(event);
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
			max_tokens: DEFAULT_COMPLETE_MAX_TOKENS,
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
						"x-api-key": this.pc.apiKey,
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

	async heartbeat(request: StreamRequest): Promise<TokenUsage | null> {
		const promptMessages = formatPrompt(request.messages, this.tags);
		const { system, messages: anthropicMessages } =
			toAnthropicFormat(promptMessages);

		// 构造与 stream() 完全一致的请求体，只覆盖 max_tokens 和 stream
		const body: AnthropicRequest = {
			model: this.modelId,
			max_tokens: 1,
			system,
			messages: anthropicMessages,
			stream: false,
		};

		if (request.tools?.length) {
			body.tools = toAnthropicTools(request.tools);
			const tc = request.toolChoice ?? "auto";
			body.tool_choice = { type: tc === "required" ? "any" : tc };
		}

		if (this.pc.thinking) {
			const budget = this.pc.thinking.budgetTokens;
			body.thinking = { type: "enabled", budget_tokens: budget };
			// thinking 模式下 max_tokens 必须 > budget_tokens
			body.max_tokens = budget + 1;
			body.temperature = 1;
		}

		try {
			const res = await fetch(this.apiUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": this.pc.apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify(body),
			});

			if (!res.ok) return null;

			const json = (await res.json()) as {
				usage?: {
					input_tokens?: number;
					output_tokens?: number;
					cache_creation_input_tokens?: number;
					cache_read_input_tokens?: number;
				};
			};

			const u = json?.usage;
			if (!u) return null;

			return {
				inputTokens: u.input_tokens ?? 0,
				outputTokens: u.output_tokens ?? 0,
				totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
				cacheReadTokens: u.cache_read_input_tokens ?? 0,
				cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
			};
		} catch {
			return null;
		}
	}

	async ping(): Promise<{ ok: boolean; error?: string }> {
		// XXX: Anthropic 无轻量 health check 端点，当前通过 stream 发送空消息排除网络问题。如果未来 Anthropic 提供了等效端点（如 GET /v1/models），应切换为直接 HTTP 请求，避免消息构建和 token 消耗。
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 15_000);
			try {
				for await (const event of this.stream(
					{ messages: [{ type: "generic_user_text", content: "hi" }] },
					controller.signal,
				)) {
					if (event.type === "error") {
						return { ok: false as const, error: event.error };
					}
					controller.abort();
					break;
				}
			} finally {
				clearTimeout(timeout);
			}
			return { ok: true as const };
		} catch (err) {
			if (err instanceof Error) {
				if (isAbortError(err)) {
					return {
						ok: false as const,
						error: "连接超时（15s），请检查网络或 API 地址",
					};
				}
				return { ok: false as const, error: err.message.slice(0, 200) };
			}
			return { ok: false as const, error: `连接失败: ${String(err)}` };
		}
	}
}
