/**
 * Agent Loop — 纯编排层
 *
 * 每一步都是一个清晰的函数调用：
 * 1. parseStream  → 流式解析，yield 语义事件
 * 2. scheduler    → 流水线并行执行（streaming 中工具就绪即入队）
 * 3. round.*      → 纯函数后处理（截断恢复、消息构建、progress 检查）
 *
 * scheduler 通过回调发射 raw 无序事件，排序由各 Renderer 实现自行决定。
 */

import type { Toolkit } from "@n0n/tools";
import type {
	DomainMessage,
	TokenUsage,
	PartialToolCallRecord,
	Renderer,
	ToolCallRecord,
	ToolDefinition,
} from "@n0n/types";
import { FinishReason, findLastUsage } from "@n0n/types";
import type { ZodType } from "zod";
import { getRuntime } from "../runtime.ts";
import { PlainRenderer } from "../ui/renderer.ts";
import {
	buildToolCallMessage,
	checkProgress,
	collectJobMessages,
	recoverTruncatedCalls,
} from "./round.ts";
import { ExecutionScheduler } from "./scheduler.ts";
import { parseStream, type StreamingResult } from "./streaming.ts";
import { executeToolStream } from "./tool.ts";

// ── 结果类型 ──

export interface AgentResult<T = unknown> {
	result: T | null;
	report: string | null;
	history: DomainMessage[];
	/** 本轮使用的工具定义列表（供 heartbeat 重建缓存前缀） */
	tools: ToolDefinition[];
}

export interface AgentOptions<T = unknown> {
	/** 工具集实例 — 由 app 层通过 makeToolkit 构造并注入 */
	toolkit: Toolkit;
	/** progress 结果的 Zod schema（用于 checkProgress 后验证） */
	schema?: ZodType<T>;
	maxIterations?: number;
	renderer?: Renderer;
	confirmFn?: (question: string) => Promise<string>;
	signal?: AbortSignal;
}

const MAX_PROGRESS_RETRIES = 4;

// ── Agent Loop ──

export async function agentLoop<T = unknown>(
	history: DomainMessage[],
	options: AgentOptions<T>,
): Promise<AgentResult<T>> {
	const runtime = getRuntime();
	const maxIter = options.maxIterations ?? runtime.agent.maxIterations;
	const renderer: Renderer = options.renderer ?? new PlainRenderer();
	const client = runtime.client;
	const toolkit = options.toolkit;
	const messages: DomainMessage[] = [...history];
	let idleCount = 0;
	let progressRetries = 0;
	for (let iter = 0; iter < maxIter; iter++) {
		if (options.signal?.aborted) {
			renderer.aborted();
			return {
				result: null,
				report: null,
				history: messages,
				tools: toolkit.tools,
			};
		}

		renderer.roundStart(iter + 1, maxIter, messages.length, findLastUsage(messages));

		// ── 1. 流式解析 + 并行执行（交织进行） ──
		const scheduler = new ExecutionScheduler(
			(tc) =>
				executeToolStream(tc, options.confirmFn, toolkit.getEntry),
			{
				onRegister: (tc) => renderer.toolExecStart(tc.id, tc),
				onChunk: (tcId, tool, chunk) =>
					renderer.toolExecChunk(tcId, tool, chunk),
				onEnd: (tcId, outcome) => renderer.toolExecEnd(tcId, outcome),
			},
		);
		const runPromise = scheduler.run(options.signal);

		let streamResult: StreamingResult | null = null;

		for await (const event of parseStream(
			client.stream(
				{ messages, tools: toolkit.tools, toolChoice: "auto" },
				options.signal,
			),
			options.signal,
		)) {
			switch (event.type) {
				// 渲染分发
				case "thinking_start":
					renderer.thinkingStart();
					break;
				case "thinking_chunk":
					renderer.thinkingChunk(event.text);
					break;
				case "thinking_end":
					renderer.thinkingEnd();
					break;
				case "content_start":
					renderer.contentStart();
					break;
				case "content_chunk":
					renderer.contentChunk(event.text);
					break;
				case "content_end":
					renderer.contentEnd();
					break;
				case "tool_arg_start":
					renderer.toolCallArgStart(event.index, event.name);
					break;
				case "tool_arg_chunk":
					renderer.toolCallArgChunk(event.index, event.chunk);
					break;

				// 工具就绪 → 渲染 + 入队调度
				case "tool_ready":
					renderer.toolCallArgEnd(event.index, event.tc);
					scheduler.enqueue(
						event.tc,
						toolkit.getEntry(event.tc.tool)?.canStart,
					);
					break;

				// streaming 完毕
				case "done":
					streamResult = event.result;
					break;

				case "error":
					// LLM stream errors are handled by streaming.ts interrupt detection
					break;

				default: {
					const _exhaustive: never = event;
					break;
				}
			}
		}
		renderer.streamEnd();

		// ── 2. 分类本轮结果，决定后续动作 ──
		const outcome = classifyRound(
			// biome-ignore lint/style/noNonNullAssertion: streamResult is always set by the stream loop above
			streamResult!,
			idleCount,
			runtime.agent.maxIdleRounds,
		);

		// 提取本轮 LLM 调用的 token 用量，后续各分支统一插入 token_usage 消息
		const roundUsage = streamResult!.accumulator.usage;
		const roundFinishReason = streamResult!.accumulator.finishReason ?? "unknown";

		if (outcome.action === "exit") {
			scheduler.seal();
			if (outcome.assistantMessage) {
				messages.push(outcome.assistantMessage);
			}
			pushTokenUsage(messages, roundUsage, roundFinishReason);
			if (outcome.reason === "aborted") renderer.aborted();
			else renderer.agentTerminated(outcome.reason);
			renderer.roundEnd();
			return {
				result: null,
				report: outcome.report,
				history: messages,
				tools: toolkit.tools,
			};
		}

		if (outcome.action === "idle") {
			scheduler.seal();
			messages.push(outcome.assistantMessage);
			pushTokenUsage(messages, roundUsage, roundFinishReason);
			idleCount++;
			if (idleCount >= runtime.agent.maxIdleRounds) {
				renderer.agentTerminated("max idle rounds exceeded (no tool calls)");
				renderer.roundEnd();
				return {
					result: null,
					// biome-ignore lint/style/noNonNullAssertion: streamResult is always set by the stream loop above
					report: `Agent terminated: max idle rounds exceeded. Last content: ${(streamResult!.accumulator.content || "").slice(0, 200)}`,
					history: messages,
					tools: toolkit.tools,
				};
			}
			messages.push({
				type: "idle_nudge",
				idleCount,
				maxIdleRounds: runtime.agent.maxIdleRounds,
			});
			renderer.roundEnd();
			continue;
		}

		if (outcome.action === "retry_truncated") {
			scheduler.seal();
			messages.push(outcome.assistantMessage);
			messages.push(outcome.retryMessage);
			pushTokenUsage(messages, roundUsage, roundFinishReason);
			renderer.roundEnd();
			continue;
		}

		// outcome.action === "execute_tools"
		idleCount = 0;

		// ── 3. 截断恢复 + seal ──
		const tryRecover = async (
			toolName: string,
			toolCallId: string,
			partialJson: string,
		) => {
			const entry = toolkit.getEntry(toolName);
			return (
				(await entry?.recoverAndExecute?.(toolCallId, partialJson)) ?? null
			);
		};
		// biome-ignore lint/style/noNonNullAssertion: streamResult is always set by the stream loop above
		const truncation = await recoverTruncatedCalls(streamResult!, tryRecover);
		scheduler.seal();

		// 合并所有工具调用：streaming 完成的 + 截断恢复的
		const allCalls: (ToolCallRecord | PartialToolCallRecord)[] = [
			// biome-ignore lint/style/noNonNullAssertion: streamResult is always set by the stream loop above
			...streamResult!.readyTools.values(),
			...truncation.pairs.map((p) => p.call),
		];

		if (allCalls.length === 0) {
			renderer.roundEnd();
			continue;
		}

		// ── 4. 构建 assistant 消息 ──
		// biome-ignore lint/style/noNonNullAssertion: streamResult is always set by the stream loop above
		messages.push(buildToolCallMessage(streamResult!.accumulator, allCalls));

		pushTokenUsage(messages, roundUsage, roundFinishReason);

		// ── 5. 等待执行 + 渲染完成 ──
		await runPromise;

		// ── 6. 收集结果消息 ──
		messages.push(...collectJobMessages(scheduler.orderedJobs()));
		// 截断恢复的 result 已由 truncation 产出（recover 内执行完毕）
		for (const pair of truncation.pairs) {
			messages.push(pair.result);
		}

		// ── 7. Progress 检查 ──
		const progress = checkProgress(
			scheduler.orderedJobs(),
			options.schema,
			progressRetries,
			MAX_PROGRESS_RETRIES,
		);
		if (progress.accepted) {
			renderer.progressAccepted();
			renderer.roundEnd();
			return {
				result: progress.accepted.value as T,
				report: null,
				history: messages,
				tools: toolkit.tools,
			};
		}
		if (progress.gaveUp) {
			renderer.progressRejected(
				progressRetries + 1,
				MAX_PROGRESS_RETRIES,
				`giving up after ${progressRetries + 1} attempts`,
			);
			renderer.roundEnd();
			return {
				result: null,
				report: `Progress validation failed after ${MAX_PROGRESS_RETRIES} retries: ${progress.gaveUp.error}`,
				history: messages,
				tools: toolkit.tools,
			};
		}
		if (progress.rejected) {
			progressRetries = progress.rejected.retries;
			renderer.progressRejected(
				progressRetries,
				MAX_PROGRESS_RETRIES,
				progress.rejected.error,
			);
			messages.push({
				type: "progress:rejected",
				error: progress.rejected.error,
				attempt: progressRetries,
				maxAttempts: MAX_PROGRESS_RETRIES,
			});
		}
		renderer.roundEnd();
	}

	return {
		result: null,
		report: `Agent terminated: max iterations (${maxIter}) exceeded`,
		history: messages,
		tools: toolkit.tools,
	};
}

// ── 本轮结果分类（纯函数） ──

type RoundOutcome =
	| { action: "exit"; reason: string; report: string | null; assistantMessage?: import("@n0n/types").AssistantTextMessage }
	| { action: "idle"; assistantMessage: import("@n0n/types").AssistantTextMessage }
	| { action: "retry_truncated"; assistantMessage: import("@n0n/types").AssistantTextMessage; retryMessage: import("@n0n/types").GenericUserTextMessage }
	| { action: "execute_tools" };

function classifyRound(
	result: StreamingResult,
	_idleCount: number,
	_maxIdleRounds: number,
): RoundOutcome {
	const hasReadyTools = result.readyTools.size > 0;
	const hasIncomplete =
		result.accumulator.toolCalls.size > result.readyTools.size;
	const hasAnyTools = hasReadyTools || hasIncomplete;
	const acc = result.accumulator;

	// aborted，无任何工具 → 直接返回
	if (result.interrupt === "aborted" && !hasAnyTools) {
		return { action: "exit", reason: "aborted", report: null };
	}

	// error，无工具 → 终止
	if (result.interrupt === "error" && !hasReadyTools) {
		return {
			action: "exit",
			reason: result.errorMessage ?? "LLM error",
			report: result.errorMessage ?? "LLM stream error",
		};
	}

	// content_filter → 终止
	if (acc.finishReason === FinishReason.CONTENT_FILTER) {
		return {
			action: "exit",
			reason: "Content was filtered by the model provider",
			report: "Agent terminated: content filter triggered",
			assistantMessage: {
				type: "assistant_text",
				content: acc.content || "",
				reasoning: acc.reasoning || undefined,
				reasoningSignature: acc.reasoningSignature || undefined,
			},
		};
	}

	// length 截断且无工具 → 告知模型重试
	if (result.interrupt === "length" && !hasAnyTools) {
		return {
			action: "retry_truncated",
			assistantMessage: {
				type: "assistant_text",
				content: acc.content || "",
				reasoning: acc.reasoning || undefined,
				reasoningSignature: acc.reasoningSignature || undefined,
			},
			retryMessage: {
				type: "generic_user_text",
				content:
					"Your previous response was truncated due to max_tokens limit. Please retry with a shorter response, or break the task into smaller steps.",
			},
		};
	}

	// 无工具调用 → idle
	if (!hasAnyTools) {
		return {
			action: "idle",
			assistantMessage: {
				type: "assistant_text",
				content: acc.content ?? "",
				reasoning: acc.reasoning || undefined,
				reasoningSignature: acc.reasoningSignature || undefined,
			},
		};
	}

	// 有工具调用 → 执行
	return { action: "execute_tools" };
}

// ── pushTokenUsage ──

function pushTokenUsage(
	messages: DomainMessage[],
	usage: TokenUsage | null | undefined,
	finishReason: string,
): void {
	if (usage) {
		messages.push({ type: "token_usage" as const, usage, finishReason });
	}
}
