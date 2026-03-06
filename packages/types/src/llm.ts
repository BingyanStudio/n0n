/**
 * LLM API 类型 — OpenAI-compatible chat completion 协议
 * 这些类型用于与 LLM provider 通信，DomainMessage 通过 adapter 转换为这些类型。
 */

// ── Request types ──

export interface LLMToolParameter {
	type: "object";
	properties: Record<string, unknown>;
	required?: string[];
	additionalProperties?: false;
}

export interface LLMToolDefinition {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: LLMToolParameter;
	};
}

export interface LLMRequestMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: LLMToolCall[];
	tool_call_id?: string;
}

export interface LLMRequest {
	model: string;
	messages: LLMRequestMessage[];
	tools?: LLMToolDefinition[];
	tool_choice?: "auto" | "none" | "required";
	temperature?: number;
	max_tokens?: number;
}

// ── Response types ──

export interface LLMToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

export interface LLMAssistantMessage {
	role: "assistant";
	content: string | null;
	tool_calls?: LLMToolCall[];
}

export interface LLMChoice {
	index: number;
	message: LLMAssistantMessage;
	finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
}

export interface LLMUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

export interface LLMResponse {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: LLMChoice[];
	usage?: LLMUsage;
}
