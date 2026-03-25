/**
 * LLM Client 抽象接口 + 流式事件类型
 *
 * 所有 provider 细节（api key、model、base url、thinking、cache）
 * 全部闭包在实现内部。消费方只看到这个接口。
 *
 * @n0n/core 和 @n0n/tools 只依赖此文件中的类型，
 * 不直接依赖 @n0n/llm，实现依赖反转。
 */

// ── Token Usage ──

/** 单轮 LLM 调用的 token 用量统计 */
export interface TokenUsage {
	/** 输入 token 总量 */
	inputTokens: number;
	/** 输出 token 总量 */
	outputTokens: number;
	/** 总 token 量 */
	totalTokens: number;
	/** 缓存命中的输入 token 数 */
	cacheReadTokens: number;
	/** 写入缓存的输入 token 数 */
	cacheWriteTokens: number;
}

// ── FinishReason ──

/**
 * 归一化的完成原因常量 — SSOT
 *
 * 各 LLM Client 负责将 provider 原生值映射到此枚举。
 * 消费方（agent loop 等）只引用这些常量，不使用魔法字符串。
 */
export const FinishReason = {
	/** 模型正常结束输出 */
	STOP: "stop",
	/** 输出因 max_tokens 截断 */
	LENGTH: "length",
	/** 模型请求调用工具 */
	TOOL_CALLS: "tool_calls",
	/** 内容被 provider 安全过滤器拦截 */
	CONTENT_FILTER: "content_filter",
} as const;
export type FinishReason = (typeof FinishReason)[keyof typeof FinishReason];

// ── StreamEvent ──

export type StreamEvent =
	| { type: "thinking"; text: string }
	| { type: "thinking_signature"; signature: string }
	| { type: "content"; text: string }
	| {
			type: "tool_call_delta";
			index: number;
			id?: string;
			name?: string;
			arguments: string;
	  }
	| { type: "done"; finishReason: string; usage: TokenUsage | null }
	| { type: "error"; error: string };

// ── ToolDefinition ──

/** 协议无关的工具定义格式。各 Client 内部转换为各自的 API 格式。 */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
		additionalProperties?: false;
	};
}

// ── PromptMessage ──

/** 提示词组织的输出格式。format-prompt 模块的产物，Client 内部消费。 */
export type PromptMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string }
	| {
			role: "assistant";
			content: string;
			reasoning?: string;
			reasoningSignature?: string;
			toolCalls?: ToolCallPart[];
	  }
	| { role: "tool"; toolCallId: string; toolName: string; content: string };

export interface ToolCallPart {
	id: string;
	tool: string;
	args: Record<string, unknown>;
}

// ── Request / Response ──

import type { DomainMessage } from "./domain.ts";

/** 流式请求 — 走 DomainMessage 领域层，或直接传入 PromptMessage */
export interface StreamRequest {
	messages: DomainMessage[];
	tools?: ToolDefinition[];
	toolChoice?: "auto" | "none" | "required";
}

/** 非流式请求 — 简单场景，裸消息 */
export interface CompleteRequest {
	messages: SimpleMessage[];
	temperature?: number;
}

export interface SimpleMessage {
	role: "system" | "user";
	content: string;
}

/** 非流式响应 */
export interface CompleteResponse {
	text: string;
}

// ── LLMClient 接口 ──

/**
 * LLM Client 抽象接口
 *
 * 所有 provider 细节（api key、model、base url、thinking、cache）
 * 全部闭包在实现内部。消费方只看到这个接口。
 */
export interface LLMClient {
	/**
	 * 流式调用 — agent loop / editor-loop 使用
	 *
	 * 接受 DomainMessage[]（领域消息），内部完成：
	 * 1. 提示词组织（DomainMessage → PromptMessage，via format-prompt）
	 * 2. 协议格式化（PromptMessage → API 消息格式）
	 * 3. SSE 解析 → StreamEvent 映射
	 */
	stream(request: StreamRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent>;

	/**
	 * 非流式调用 — RAG 等简单场景使用
	 *
	 * 接受裸消息（不经过 DomainMessage 领域层）
	 */
	complete(request: CompleteRequest): Promise<CompleteResponse>;

	/**
	 * LLM 模型标识（只读）
	 *
	 * 如 "claude-3.5-sonnet"、"deepseek-chat"
	 * 用途：makeToolkit 构建 exec 工具描述时需要 tag 风格
	 */
	readonly modelId: string;
}

// ── StreamAccumulator ──

/** 流式累积后的单个 tool call */
export interface AssistantToolCallPart {
	toolCallId: string;
	toolName: string;
	/** JSON 字符串形式的参数 */
	input: string;
}

/** 累积后的 assistant 消息 */
export interface AssistantMessage {
	role: "assistant";
	content: string | null;
	reasoningText: string | null;
	reasoningSignature: string | null;
	toolCalls: AssistantToolCallPart[];
}

/** 累积流式事件为完整消息 */
export class StreamAccumulator {
	content = "";
	reasoning = "";
	reasoningSignature = "";
	toolCalls = new Map<
		number,
		{ toolCallId: string; toolName: string; input: string }
	>();
	finishReason: string | null = null;
	/** 本轮 LLM 调用的 token 用量 */
	usage: TokenUsage | null = null;

	push(event: StreamEvent): void {
		switch (event.type) {
			case "thinking":
				this.reasoning += event.text;
				break;
			case "thinking_signature":
				this.reasoningSignature = event.signature;
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
				this.usage = event.usage;
				break;
			case "error":
				// error 事件不累积，由消费方直接处理
				break;
		}
	}

	toMessage(): AssistantMessage {
		return {
			role: "assistant",
			content: this.content || null,
			reasoningText: this.reasoning || null,
			reasoningSignature: this.reasoningSignature || null,
			toolCalls: [...this.toolCalls.values()],
		};
	}
}
