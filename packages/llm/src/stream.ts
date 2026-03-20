/**
 * LLM Streaming — 基于 Vercel AI SDK 的流式调用
 *
 * 使用 streamText() + fullStream 替代手写 SSE 解析，自动处理：
 * - 多 provider 流式协议差异
 * - abort 信号传递
 * - thinking/reasoning token 流式输出
 * - tool call 流式参数输出
 *
 * StreamEvent 与旧 API 基本兼容（注意：done.finishReason 从 string | null 收窄为 string）。
 */

import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { streamText } from "ai";

// ── StreamEvent — 流式事件类型（与旧 API 兼容） ──

export type StreamEvent =
	| { type: "thinking"; text: string }
	| { type: "content"; text: string }
	| {
			type: "tool_call_delta";
			/** 工具调用的顺序索引（从 0 开始），兼容 Renderer.toolCallArgChunk */
			index: number;
			id: string | undefined;
			name: string | undefined;
			arguments: string;
	  }
	| { type: "done"; finishReason: string };

// ── 流式请求 ──

export interface StreamRequest {
	messages: ModelMessage[];
	tools?: ToolSet;
	toolChoice?: "auto" | "none" | "required";
	temperature?: number;
	maxOutputTokens?: number;
}

export interface StreamOptions {
	signal?: AbortSignal;
	model: LanguageModel;
}

/**
 * 流式 chat completion — 生成 StreamEvent 序列
 *
 * 运行时依赖注入：
 * - 传入 LanguageModel 实例（推荐）
 */
export async function* chatCompletionStream(
	request: StreamRequest,
	options: StreamOptions,
): AsyncGenerator<StreamEvent> {
	const model = options.model;

	const result = streamText({
		model,
		messages: request.messages,
		tools: request.tools,
		toolChoice: request.toolChoice,
		temperature: request.temperature,
		maxOutputTokens: request.maxOutputTokens,
		abortSignal: options.signal,
		maxRetries: 3,
	});

	/** id → 顺序 index 映射，兼容 Renderer.toolCallArgChunk(index: number) */
	const idToIndex = new Map<string, number>();
	let nextIndex = 0;

	function resolveIndex(id: string): number {
		let idx = idToIndex.get(id);
		if (idx === undefined) {
			idx = nextIndex++;
			idToIndex.set(id, idx);
		}
		return idx;
	}

	for await (const part of result.fullStream) {
		switch (part.type) {
			case "reasoning-delta":
				yield { type: "thinking", text: part.text };
				break;

			case "text-delta":
				yield { type: "content", text: part.text };
				break;

			case "tool-input-start":
				yield {
					type: "tool_call_delta",
					index: resolveIndex(part.id),
					id: part.id,
					name: part.toolName,
					arguments: "",
				};
				break;

			case "tool-input-delta":
				yield {
					type: "tool_call_delta",
					index: resolveIndex(part.id),
					id: undefined,
					name: undefined,
					arguments: part.delta,
				};
				break;

			case "finish":
				yield { type: "done", finishReason: part.finishReason };
				break;
		}
	}
}

// ── StreamAccumulator — 累积流式事件为完整消息 ──

/** 流式累积后的单个 tool call — SSOT 类型，tool.ts 中的 parseToolCalls 也使用此类型 */
export interface AssistantToolCallPart {
	toolCallId: string;
	toolName: string;
	/** JSON 字符串形式的参数 */
	input: string;
}

/** AI SDK 格式的 assistant 消息 */
export interface AssistantMessage {
	role: "assistant";
	content: string | null;
	reasoningText: string | null;
	toolCalls: AssistantToolCallPart[];
}

export class StreamAccumulator {
	content = "";
	reasoning = "";
	toolCalls = new Map<
		number,
		{ toolCallId: string; toolName: string; input: string }
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
					tc = {
						toolCallId: event.id ?? "",
						toolName: event.name ?? "",
						input: "",
					};
					this.toolCalls.set(event.index, tc);
				}
				if (event.id) tc.toolCallId = event.id;
				if (event.name) tc.toolName = event.name;
				tc.input += event.arguments;
				break;
			}
			case "done":
				this.finishReason = event.finishReason;
				break;
		}
	}

	toMessage(): AssistantMessage {
		const toolCalls = [...this.toolCalls.values()];

		return {
			role: "assistant",
			content: this.content || null,
			reasoningText: this.reasoning || null,
			toolCalls,
		};
	}
}
