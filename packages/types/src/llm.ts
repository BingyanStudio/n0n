/**
 * LLM API 类型
 *
 * 分为两部分：
 * 1. 仍在使用的类型（LLMToolDefinition, LLMToolCall）— 工具注册表和 parseToolCalls 依赖
 * 2. @deprecated 类型 — 已被 AI SDK 类型替代，待后续清理
 *
 * 迁移路径：
 * - LLMToolDefinition → AI SDK `tool()` 函数定义（tools/index.ts 需重构）
 * - LLMToolCall → AI SDK ToolCallPart { toolCallId, toolName, input }
 * - LLMRequestMessage → AI SDK ModelMessage（已在 adapter.ts 完成）
 * - LLMRequest/LLMResponse → AI SDK generateText/streamText（已在 client.ts/stream.ts 完成）
 */

// ── 仍在使用 ──

export interface LLMToolParameter {
	type: "object";
	properties: Record<string, unknown>;
	required?: string[];
	additionalProperties?: false;
}

/**
 * LLM 工具定义 — OpenAI function calling 格式
 *
 * 仍被 tools 注册表使用。后续迁移到 AI SDK `tool()` 后可移除。
 */
export interface LLMToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: LLMToolParameter;
	};
}

/**
 * LLM 工具调用 — OpenAI function calling 响应格式
 *
 * 仍被 parseToolCalls 使用。后续迁移到 AI SDK ToolCallPart 后可移除。
 */
export interface LLMToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

// ── @deprecated — 已被 AI SDK 类型替代 ──

/**
 * @deprecated 使用 AI SDK `ModelMessage` 替代。见 `@n0n/llm` adapter.ts。
 */
export interface LLMRequestMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	reasoning_content?: string | null;
	tool_calls?: LLMToolCall[];
	tool_call_id?: string;
}

/**
 * @deprecated 使用 AI SDK `generateText()` / `streamText()` 替代。见 `@n0n/llm` client.ts。
 */
export interface LLMRequest {
	model: string;
	messages: LLMRequestMessage[];
	tools?: LLMToolDefinition[];
	tool_choice?: "auto" | "none" | "required";
	temperature?: number;
	max_tokens?: number;
}

/**
 * @deprecated 使用 `@n0n/llm` 的 `AssistantMessage` 替代。
 */
export interface LLMAssistantMessage {
	role: "assistant";
	content: string | null;
	reasoning_content?: string | null;
	tool_calls?: LLMToolCall[];
}

/**
 * @deprecated 使用 AI SDK `GenerateTextResult` 替代。
 */
export interface LLMChoice {
	index: number;
	message: LLMAssistantMessage;
	finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

/**
 * @deprecated 使用 AI SDK `LanguageModelUsage` 替代。
 */
export interface LLMUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

/**
 * @deprecated 使用 `@n0n/llm` 的 `ChatCompletionResult` 替代。
 */
export interface LLMResponse {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: LLMChoice[];
	usage?: LLMUsage;
}
