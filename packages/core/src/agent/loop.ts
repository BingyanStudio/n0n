/**
 * Agent Loop — 核心 agent 循环
 *
 * 接收 DomainMessage[] 历史，驱动 LLM + 工具调用循环，
 * 直到 agent 调用 submit 或达到终止条件。
 *
 * 使用 LLMClient.stream() 进行流式调用，支持多 provider。
 */

import type { PendingReminder, ToolsConfig } from "@n0n/tools";
import { makeToolkit } from "@n0n/tools";
import type {
	AssistantToolCallMessage,
	DomainMessage,
	Renderer,
	TokenUsage,
	ToolResult,
} from "@n0n/types";
import { FinishReason, StreamAccumulator } from "@n0n/types";
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

// ── Agent Loop ──

export async function agentLoop<T = unknown>(
	history: DomainMessage[],
	options?: AgentOptions<T>,
): Promise<AgentResult<T>> {
	const maxIter = options?.maxIterations ?? getRuntime().agent.maxIterations;
	const renderer = options?.renderer ?? new PlainRenderer();
	const runtime = getRuntime();
	const client = runtime.client;
	const modelId = client.modelId;
	const toolsConfig: ToolsConfig = {
		security: runtime.security,
		agent: runtime.agent,
		editorClient: runtime.editorClient,
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
	/** 上一轮 LLM 调用的 token 用量（传给 roundStart 显示） */
	let lastUsage: TokenUsage | null = null;

	for (let iteration = 0; iteration < maxIter; iteration++) {
		if (options?.signal?.aborted) {
			renderer.aborted();
			return { result: null, report: null, history: messages };
		}

		injectReminders(messages, reminders);

		renderer.roundStart(iteration + 1, maxIter, messages.length, lastUsage);

		const acc = new StreamAccumulator();
		// ── 上游状态：驱动指令式事件，Renderer 不需要推断 ──
		let isInThinking = false;
		let hasContent = false;
		const seenToolIndices = new Set<number>();
		const completedToolIndices = new Set<number>();

		for await (const event of client.stream(
			{
				messages,
				tools: toolkit.tools,
				toolChoice: "auto",
			},
			options?.signal,
		)) {
			if (options?.signal?.aborted) {
				renderer.aborted();
				return { result: null, report: null, history: messages };
			}
			acc.push(event);
			switch (event.type) {
				case "thinking":
					isInThinking = true;
					renderer.thinkingChunk(event.text);
					break;
				case "content":
					if (isInThinking) {
						isInThinking = false;
						renderer.thinkingEnd();
					}
					renderer.contentChunk(event.text);
					hasContent = true;
					break;
				case "tool_call_delta": {
					if (isInThinking) {
						isInThinking = false;
						renderer.thinkingEnd();
					}
					if (hasContent) {
						hasContent = false;
						renderer.contentEnd();
					}
					// 首次遇到该 index → 发出 argStart 指令
					if (!seenToolIndices.has(event.index)) {
						seenToolIndices.add(event.index);
						renderer.toolCallArgStart(event.index, event.name ?? "?");
					}
					renderer.toolCallArgChunk(event.index, event.arguments);
					// JSON 完整性检测 → 发出 argEnd 指令
					if (!completedToolIndices.has(event.index)) {
						const tcAcc = acc.toolCalls.get(event.index);
						if (tcAcc) {
							try {
								JSON.parse(tcAcc.input);
								completedToolIndices.add(event.index);
								const parsed = parseToolCalls([tcAcc]);
								const parsedTc = parsed[0];
								if (parsedTc && isValidToolCall(parsedTc)) {
									renderer.toolCallArgEnd(event.index, parsedTc);
								}
							} catch {
								// JSON 尚未完整，继续累积
							}
						}
					}
					break;
				}
				case "error":
					if (isInThinking) renderer.thinkingEnd();
					renderer.streamEnd();
					renderer.agentTerminated(`LLM error: ${event.error}`);
					return {
						result: null,
						report: `LLM error: ${event.error}`,
						history: messages,
					};
			}
		}
		if (hasContent) renderer.contentEnd();
		if (isInThinking) renderer.thinkingEnd();
		renderer.streamEnd();

		// 记录本轮 usage，下一轮 roundStart 时显示
		lastUsage = acc.usage;

		if (options?.signal?.aborted) {
			renderer.aborted();
			return { result: null, report: null, history: messages };
		}

		// finishReason 检查 — 截断恢复与内容过滤处理
		if (acc.finishReason === FinishReason.LENGTH) {
			// 模型输出因 max_tokens 截断，工具调用 JSON 可能不完整
			// 将已有内容保存为 assistant_text，通知用户截断情况
			const partialContent = acc.content || "";
			messages.push({
				type: "assistant_text",
				content: partialContent,
				reasoning: acc.reasoning || undefined,
				reasoningSignature: acc.reasoningSignature || undefined,
			});
			messages.push({
				type: "user_text",
				content:
					"Your previous response was truncated due to max_tokens limit. " +
					"The tool call JSON was incomplete and could not be parsed. " +
					"Please retry with a shorter response, or break the task into smaller steps.",
			});
			continue;
		}

		if (acc.finishReason === FinishReason.CONTENT_FILTER) {
			const partialContent = acc.content || "";
			messages.push({
				type: "assistant_text",
				content: partialContent,
				reasoning: acc.reasoning || undefined,
				reasoningSignature: acc.reasoningSignature || undefined,
			});
			renderer.agentTerminated("Content was filtered by the model provider.");
			return {
				result: null,
				report: "Agent terminated: content filter triggered",
				history: messages,
			};
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
				reasoningSignature: assistantMsg.reasoningSignature,
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

		// tool calls → ToolCallRecord
		const toolCalls = parseToolCalls(assistantMsg.toolCalls).filter(
			isValidToolCall,
		);

		if (toolCalls.length === 0) {
			const content = assistantMsg.content ?? "";
			idleCount++;
			messages.push({
				type: "assistant_text",
				content,
				reasoning: assistantMsg.reasoningText,
				reasoningSignature: assistantMsg.reasoningSignature,
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
			reasoningSignature: assistantMsg.reasoningSignature,
			toolCalls,
		};
		messages.push(toolCallMsg);

		for (const tc of toolCalls) {
			if (options?.signal?.aborted) {
				renderer.aborted();
				return { result: null, report: null, history: messages };
			}
			renderer.toolExecStart(tc);
			let result: ToolResult | undefined;
			let argError = false;
			for await (const event of executeToolStream(
				tc,
				reminders,
				options?.confirmFn,
				toolkit.getEntry,
			)) {
				if (event.type === "tool_output_chunk") {
					renderer.toolExecChunk(event.tool, event.chunk);
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
			renderer.toolExecEnd(result);
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
