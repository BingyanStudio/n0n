/**
 * LLM 共享错误类型
 *
 * OpenAI Client 和 Anthropic Client 共用的错误定义。
 * 从 openai-client.ts 提取，消除两个平行 Client 之间的不必要依赖。
 */

/** LLM API 调用错误（HTTP 非 2xx 响应） */
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

/** 判断错误是否为用户主动取消（AbortController.abort()） */
export function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}
