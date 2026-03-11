/**
 * LLM 流式请求 — SSE 解析 + StreamAccumulator
 */

import type { LLMAssistantMessage, LLMRequest, LLMToolCall } from "@n0n/types";
import { LLMError } from "./client.ts";
import type { LLMConfig } from "./config.ts";

// ── StreamEvent 类型 ──

export type StreamEvent =
	| { type: "thinking"; text: string }
	| { type: "content"; text: string }
	| {
			type: "tool_call_delta";
			index: number;
			id?: string;
			name?: string;
			arguments: string;
	  }
	| { type: "done"; finishReason: string | null };

// ── SSE 流式请求 ──

export async function* chatCompletionStream(
	request: Omit<LLMRequest, "model">,
	options: { signal?: AbortSignal; llm: LLMConfig },
): AsyncGenerator<StreamEvent> {
	const config = options.llm;
	const body: LLMRequest & { stream: true; enable_thinking?: boolean } = {
		model: config.model,
		...request,
		stream: true,
	};

	if (config.enableThinking) {
		body.enable_thinking = true;
	}

	if (!body.tools?.length) {
		body.tools = undefined;
		body.tool_choice = undefined;
	}

	const base = config.baseUrl;
	const url = base.includes("/chat/completions")
		? base
		: `${base}/v1/chat/completions`;

	let res: Response;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: options?.signal,
		});
	} catch (err) {
		if (isAbortError(err)) return;
		throw err;
	}

	if (!res.ok) {
		const text = await res.text();
		throw new LLMError(`LLM API ${res.status}: ${text}`, res.status, text);
	}

	if (!res.body) throw new Error("LLM streaming response has no body");

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
						return;
					}

					let chunk: unknown;
					try {
						chunk = JSON.parse(payload);
					} catch {
						continue;
					}

					// 轻量结构校验：确保 choices 数组存在
					if (!isSSEChunk(chunk)) continue;

					const delta = chunk.choices?.[0]?.delta;
					if (!delta) continue;

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

					const finish = chunk.choices?.[0]?.finish_reason;
					if (finish) {
						yield { type: "done", finishReason: finish };
					}
				}
				boundary = buffer.indexOf("\n\n");
			}
		}
	} catch (err) {
		if (!isAbortError(err)) throw err;
	} finally {
		reader.releaseLock();
	}
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

// ── SSE Chunk 类型（内部） ──

/** 轻量结构校验 — 确保 SSE chunk 具有 choices 数组 */
function isSSEChunk(data: unknown): data is SSEChunk {
	if (typeof data !== "object" || data === null) return false;
	const obj = data as Record<string, unknown>;
	return Array.isArray(obj.choices);
}

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
}

// ── StreamAccumulator — 累积为完整消息 ──

export class StreamAccumulator {
	content = "";
	reasoning = "";
	toolCalls = new Map<
		number,
		{ id: string; name: string; arguments: string }
	>();
	finishReason: string | null = null;

	push(event: StreamEvent): void {
		switch (event.type) {
			case "thinking":
				this.reasoning += event.text;
				break;
			case "content":
				this.content += event.text;
				break;
			case "tool_call_delta": {
				let tc = this.toolCalls.get(event.index);
				if (!tc) {
					tc = { id: event.id ?? "", name: event.name ?? "", arguments: "" };
					this.toolCalls.set(event.index, tc);
				}
				if (event.id) tc.id = event.id;
				if (event.name) tc.name = event.name;
				tc.arguments += event.arguments;
				break;
			}
			case "done":
				this.finishReason = event.finishReason;
				break;
		}
	}

	toMessage(): LLMAssistantMessage {
		const toolCalls: LLMToolCall[] = [];
		for (const [, tc] of [...this.toolCalls.entries()].sort(
			(a, b) => a[0] - b[0],
		)) {
			toolCalls.push({
				id: tc.id,
				type: "function",
				function: { name: tc.name, arguments: tc.arguments },
			});
		}

		return {
			role: "assistant",
			content: this.content || null,
			tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
		};
	}
}
