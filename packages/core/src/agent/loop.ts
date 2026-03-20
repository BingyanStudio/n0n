/**
 * Agent Loop — 核心 agent 循环
 *
 * 接收 DomainMessage[] 历史，驱动 LLM + 工具调用循环，
 * 直到 agent 调用 submit 或达到终止条件。
 *
 * 使用 AI SDK streamText 进行流式调用，支持多 provider 和 prompt caching。
 */

import {
	chatCompletionStream,
	StreamAccumulator,
	toAPIMessages,
	getModelId,
} from "@n0n/llm";
import type { LLMConfig } from "@n0n/llm";
import type { PendingReminder, ToolsConfig } from "@n0n/tools";
import { makeToolkit } from "@n0n/tools";
import type {
	AssistantToolCallMessage,
	DomainMessage,
	LLMToolCall,
	Renderer,
	ToolResult,
} from "@n0n/types";
import type { ZodType } from "zod";
import { toJSONSchema } from "zod";
import { getRuntime } from "../runtime.ts";
import { PlainRenderer } from "../ui/renderer.ts";
import { executeToolStream, isValidToolCall, parseToolCalls } from "./tool.ts";

// ── 结果类型 ──

export interface AgentResult<T = unknown> {
	result: T | null;
	report: string | null;
	history: DomainMessage[];
}

export interface AgentOptions<T = unknown> {
	maxIterations?: number;
	schema?: ZodType<T>;
	renderer?: Renderer;
	confirmFn?: (question: string) => Promise<string>;
	signal?: AbortSignal;
	/** 工具执行的工作区覆盖（用于 per-session 隔离，如 Feishu 多用户场景） */
	toolsWorkspace?: { workspace: string; tempDir: string };
}

const MAX_SUBMIT_RETRIES = 4;

/**
 * 将新格式的 toolCalls 转换为旧格式的 LLMToolCall[]
 *
 * AI SDK 返回 { toolCallId, toolName, input }，
 * parseToolCalls 期望 { id, type, function: { name, arguments } }
 */
function toLLMToolCalls(
	toolCalls: Array<{ toolCallId: string; toolName: string; input: string }>,
): LLMToolCall[] {
	return toolCalls.map((tc) => ({
		id: tc.toolCallId,
		type: "function" as const,
		function: {
			name: tc.toolName,
			arguments: tc.input,
		},
	}));
}

// ── Agent Loop ──

export async function agentLoop<T = unknown>(
	history: DomainMessage[],
	options?: AgentOptions<T>,
): Promise<AgentResult<T>> {
	const maxIter = options?.maxIterations ?? getRuntime().agent.maxIterations;
	const renderer = options?.renderer ?? new PlainRenderer();
	const runtime = getRuntime();
	const modelId = runtime.modelId;
	const toolsConfig: ToolsConfig = {
		security: runtime.security,
		agent: runtime.agent,
		editorLlm: runtime.editorLlm,
		...(options?.toolsWorkspace ?? {
			workspace: process.cwd(),
			tempDir: ".temp",
		}),
	};
	const toolkit = await makeToolkit(options?.schema, toolsConfig, modelId);
	const messages: DomainMessage[] = [...history];
	const reminders: PendingReminder[] = [];
	let idleCount = 0;
	let submitRetries = 0;

	for (let iteration = 0; iteration < maxIter; iteration++) {
		if (options?.signal?.aborted) {
			renderer.aborted();
			return { result: null, report: null, history: messages };
		}

		injectReminders(messages, reminders);

		const apiMessages = toAPIMessages(messages, modelId, runtime.providerType);
		renderer.roundStart(iteration + 1, maxIter, apiMessages.length);

		const acc = new StreamAccumulator();
		for await (const event of chatCompletionStream(
			{
				messages: apiMessages,
				tools: toolkit.toolSet,
				toolChoice: "auto",
			},
			{ signal: options?.signal, model: runtime.model },
		)) {
			if (options?.signal?.aborted) {
				renderer.aborted();
				return { result: null, report: null, history: messages };
			}
			acc.push(event);
			switch (event.type) {
				case "thinking":
					renderer.thinkingToken(event.text);
					break;
				case "content":
					renderer.contentToken(event.text);
					break;
				case "tool_call_delta":
					renderer.toolCallArgChunk(event.index, event.name, event.arguments);
					break;
			}
		}
		renderer.contentEnd();

		if (options?.signal?.aborted) {
			renderer.aborted();
			return { result: null, report: null, history: messages };
		}

		const assistantMsg = acc.toMessage();
		const hasToolCalls = assistantMsg.toolCalls.length > 0;

		if (!hasToolCalls) {
			const content = assistantMsg.content ?? "";
			idleCount++;
			if (!acc.reasoning && !content) {
				renderer.textResponse(content, idleCount);
			}
			messages.push({
				type: "assistant_text",
				content,
				reasoning: assistantMsg.reasoningText,
			});

			if (idleCount >= getRuntime().agent.maxIdleRounds) {
				renderer.agentTerminated("max idle rounds exceeded (no tool calls)");
				return {
					result: null,
					report: `Agent terminated: max idle rounds exceeded (no tool calls). Last content: ${content.slice(0, 200)}`,
					history: messages,
				};
			}

			messages.push({
				type: "idle_nudge",
				idleCount,
				maxIdleRounds: getRuntime().agent.maxIdleRounds,
			});
			continue;
		}

		idleCount = 0;

		// 适配：新 toolCalls 格式 → 旧 LLMToolCall 格式 → ToolCallRecord
		const llmToolCalls = toLLMToolCalls(assistantMsg.toolCalls);
		const toolCalls = parseToolCalls(llmToolCalls).filter(isValidToolCall);

		if (toolCalls.length === 0) {
			const content = assistantMsg.content ?? "";
			idleCount++;
			messages.push({
				type: "assistant_text",
				content,
				reasoning: assistantMsg.reasoningText,
			});
			if (idleCount >= getRuntime().agent.maxIdleRounds) {
				renderer.agentTerminated("max idle rounds exceeded (no tool calls)");
				return {
					result: null,
					report: `Agent terminated: max idle rounds exceeded (no tool calls). Last content: ${content.slice(0, 200)}`,
					history: messages,
				};
			}
			messages.push({
				type: "idle_nudge",
				idleCount,
				maxIdleRounds: getRuntime().agent.maxIdleRounds,
			});
			continue;
		}

		const toolCallMsg: AssistantToolCallMessage = {
			type: "assistant_tool_call",
			content: assistantMsg.content,
			reasoning: assistantMsg.reasoningText,
			toolCalls,
		};
		messages.push(toolCallMsg);

		for (const tc of toolCalls) {
			if (options?.signal?.aborted) {
				renderer.aborted();
				return { result: null, report: null, history: messages };
			}
			renderer.toolCallStart(tc);
			let result: ToolResult | undefined;
			let argError = false;
			for await (const event of executeToolStream(
				tc,
				reminders,
				options?.confirmFn,
				toolkit.getEntry,
			)) {
				if (event.type === "tool_output_chunk") {
					renderer.toolResultChunk(event.tool, event.chunk);
				} else if (event.type === "tool_arg_error") {
					messages.push(event);
					argError = true;
				} else {
					result = event;
				}
			}
			if (argError) continue;
			if (!result) {
				throw new Error(`Tool ${tc.tool} stream ended without a result`);
			}
			renderer.toolCallEnd(result);
			messages.push(result);

			if (result.tool === "submit") {
				const validation = validateSubmit(
					result.cleanedResult,
					options?.schema,
				);
				if (validation.ok) {
					renderer.submitAccepted();
					return {
						result: validation.value,
						report: result.call.args.report ?? null,
						history: messages,
					};
				}
				submitRetries++;
				if (submitRetries >= MAX_SUBMIT_RETRIES) {
					renderer.submitRejected(
						submitRetries,
						MAX_SUBMIT_RETRIES,
						`giving up after ${submitRetries} attempts`,
					);
					return {
						result: null,
						report: `Submit validation failed after ${MAX_SUBMIT_RETRIES} retries: ${validation.error}`,
						history: messages,
					};
				}
				renderer.submitRejected(
					submitRetries,
					MAX_SUBMIT_RETRIES,
					validation.error,
				);
				messages.push({
					type: "submit:rejected",
					error: validation.error,
					attempt: submitRetries,
					maxAttempts: MAX_SUBMIT_RETRIES,
				});
				break;
			}
		}
	}

	return {
		result: null,
		report: `Agent terminated: max iterations (${maxIter}) exceeded`,
		history: messages,
	};
}

// ── 辅助函数 ──

function validateSubmit<T = unknown>(
	raw: unknown,
	schema?: ZodType<T>,
): { ok: true; value: T } | { ok: false; error: string } {
	if (!schema) {
		return { ok: true, value: raw as T };
	}

	const result = schema.safeParse(raw);
	if (result.success) {
		return { ok: true, value: result.data };
	}

	const issues = result.error.issues
		.map((i) => `  ${String(i.path.join("."))}: ${i.message}`)
		.join("\n");

	let fullSchema: string;
	try {
		fullSchema = JSON.stringify(toJSONSchema(schema), null, 2);
	} catch {
		fullSchema = "(schema serialization failed)";
	}

	return {
		ok: false,
		error: `Result does not match expected schema:\n${issues}\n\nFull expected schema:\n${fullSchema}`,
	};
}

function injectReminders(
	messages: DomainMessage[],
	reminders: PendingReminder[],
): void {
	const due: PendingReminder[] = [];
	const remaining: PendingReminder[] = [];

	for (const r of reminders) {
		r.roundsLeft--;
		if (r.roundsLeft <= 0) {
			due.push(r);
		} else {
			remaining.push(r);
		}
	}

	reminders.length = 0;
	reminders.push(...remaining);

	for (const r of due) {
		messages.push({
			type: "reminder:due",
			content: r.content,
			originalDelay: r.originalDelay,
		});
	}
}
