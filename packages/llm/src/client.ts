/**
 * LLM Client — 基于 Vercel AI SDK 的非流式调用
 *
 * 使用 generateText() 替代手写 fetch，自动处理：
 * - 多 provider 协议差异（OpenAI / Anthropic / Google）
 * - 退避重试（429/5xx）
 * - 结构化响应解析
 */

import { generateText } from "ai";
import type { LanguageModel, ModelMessage } from "ai";

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

/** 非流式 chat completion 请求参数 */
export interface ChatCompletionRequest {
	messages: ModelMessage[];
	temperature?: number;
	maxOutputTokens?: number;
}

/** 非流式 chat completion 响应 */
export interface ChatCompletionResult {
	text: string;
	reasoningText: string | undefined;
	toolCalls: Array<{
		toolCallId: string;
		toolName: string;
		input: unknown;
	}>;
	finishReason: string;
	usage: {
		inputTokens: number | undefined;
		outputTokens: number | undefined;
	};
}

/**
 * 发送非流式 chat completion 请求
 *
 * 接受 LanguageModel 实例，由外部 DI 构造。
 */
export async function chatCompletion(
	request: ChatCompletionRequest,
	model: LanguageModel,
): Promise<ChatCompletionResult> {

	try {
		const result = await generateText({
			model,
			messages: request.messages,
			temperature: request.temperature,
			maxOutputTokens: request.maxOutputTokens,
			maxRetries: 3,
		});

		return {
			text: result.text,
			reasoningText: result.reasoningText,
			toolCalls: result.toolCalls.map((tc) => ({
				toolCallId: tc.toolCallId,
				toolName: tc.toolName,
				input: "input" in tc ? tc.input : undefined,
			})),
			finishReason: result.finishReason,
			usage: {
				inputTokens: result.usage.inputTokens,
				outputTokens: result.usage.outputTokens,
			},
		};
	} catch (err) {
		if (err instanceof Error && "statusCode" in err) {
			const status = (err as { statusCode: number }).statusCode;
			throw new LLMError(err.message, status, err);
		}
		throw err;
	}
}
