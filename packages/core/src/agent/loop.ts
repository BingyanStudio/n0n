/**
 * Agent Loop — 核心 agent 循环
 *
 * 接收 DomainMessage[] 历史，驱动 LLM + 工具调用循环，
 * 直到 agent 调用 submit 或达到终止条件。
 *
 * 使用 LLMClient.stream() 进行流式调用，支持多 provider。
 *
 * 流水线执行：参数就绪即入队调度、贪婪并行执行、顺序渲染。
 * 调度模型见 pipeline.ts。
 * TODO 当前 loop.ts 同时承担了 streaming 事件分发、截断恢复、调度编排、渲染驱动等职责，与 pipeline.ts 存在耦合。后续应考虑将 streaming 解析、截断处理、工具编排等拆分为独立模块，降低单文件复杂度。
 */

import type { PendingReminder, ToolsConfig } from "@n0n/tools";
import { makeToolkit } from "@n0n/tools";
import type {
	AssistantToolCallMessage,
	DomainMessage,
	Renderer,
	ToolCallRecord,
	ToolResult,
	TokenUsage,
	TruncatedToolCallInfo,
} from "@n0n/types";
import { FinishReason, StreamAccumulator } from "@n0n/types";
import type { ZodType } from "zod";
import { toJSONSchema } from "zod";
import { getRuntime } from "../runtime.ts";
import { PlainRenderer } from "../ui/renderer.ts";
import { ExecutionScheduler, RenderBuffer } from "./pipeline.ts";
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

		// ── 流水线调度器：参数就绪即入队执行 ──
		const scheduler = new ExecutionScheduler((tc) =>
			executeToolStream(tc, reminders, options?.confirmFn, toolkit.getEntry),
		);
		const renderBuffer = new RenderBuffer();
		scheduler.attachRenderBuffer(renderBuffer);
		/** 已完整解析的工具（index → ToolCallRecord），用于截断处理 */
		const completedTools = new Map<number, ToolCallRecord>();
		/** streaming 是否因中断而提前结束 */
		let streamInterrupted: "length" | "error" | "aborted" | null = null;
		// 非阻塞启动调度循环（streaming 阶段即可开始并行执行）
		const runPromise = scheduler.run(options?.signal);

		for await (const event of client.stream(
			{
				messages,
				tools: toolkit.tools,
				toolChoice: "auto",
			},
			options?.signal,
		)) {
			if (options?.signal?.aborted) {
				streamInterrupted = "aborted";
				break;
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
					// JSON 完整性检测 → 发出 argEnd 指令 + 入队调度器
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
									completedTools.set(event.index, parsedTc);
									// 流水线：参数就绪即入队
									scheduler.enqueue(parsedTc);
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
					streamInterrupted = "error";
					break;
			}
		}
		if (hasContent) renderer.contentEnd();
		if (isInThinking) renderer.thinkingEnd();
		renderer.streamEnd();

		// 记录本轮 usage，下一轮 roundStart 时显示
		lastUsage = acc.usage;

		if (streamInterrupted === "aborted") {
			renderer.aborted();
			return { result: null, report: null, history: messages };
		}

		if (streamInterrupted === "error") {
			renderer.agentTerminated(`LLM error`);
			return {
				result: null,
				report: "LLM stream error",
				history: messages,
			};
		}

		// ── 截断/过滤处理 ──
		const hasIncompleteTools = seenToolIndices.size > completedToolIndices.size;

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

		if (acc.finishReason === FinishReason.LENGTH) {
			streamInterrupted = "length";
		}

		// ── 构建 assistant 消息 ──
		const assistantMsg = acc.toMessage();
		const allToolCalls = parseToolCalls(assistantMsg.toolCalls).filter(isValidToolCall);

		// 对于截断场景：已完整的 toolCalls + 未完整的 toolCalls 都记录
		// 未完整的通过 tool_call:truncated 消息回复（方案 B）
		const hasToolCalls = allToolCalls.length > 0 || hasIncompleteTools;

		if (!hasToolCalls && !streamInterrupted) {
			// 无工具调用的纯文本回复
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

		if (!hasToolCalls && streamInterrupted === "length") {
			// 截断但无任何工具调用（纯文本被截断）
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
					"Please retry with a shorter response, or break the task into smaller steps.",
			});
			continue;
		}

		idleCount = 0;

		// ── 构建 toolCalls 列表 + 截断分路处理 ──
		const toolCallsForMsg = [...allToolCalls];
		const truncatedCalls: TruncatedToolCallInfo[] = [];
		/** 已补全并入队的截断 write 的路径（用于后续推送截断提示） */
		const completedTruncatedWritePaths: string[] = [];

		for (const idx of seenToolIndices) {
			if (completedToolIndices.has(idx)) continue;
			const tcAcc = acc.toolCalls.get(idx);
			if (!tcAcc) continue;
			const callId = tcAcc.toolCallId;
			const toolName = tcAcc.toolName;
			// 过滤严重难解析的工具调用：工具名或 callId 缺失时直接丢弃
			if (!callId || !toolName) continue;

			// write 工具特殊处理：尝试从截断的 JSON 中提取 path + content，补全为正常调用并写入文件
			if (toolName === "write") {
				const partialWrite = tryExtractPartialWrite(tcAcc.input);
				if (partialWrite) {
					const writeTc: ToolCallRecord = {
						id: callId,
						tool: "write",
						args: { path: partialWrite.path, content: partialWrite.content },
					} as ToolCallRecord;
					toolCallsForMsg.push(writeTc);
					scheduler.enqueue(writeTc);
					completedTruncatedWritePaths.push(partialWrite.path);
					continue;
				}
			}

			// 非 write / 无法补全的截断工具 → 记入 truncatedCalls，adapter 层生成协议对
			truncatedCalls.push({ id: callId, tool: toolName, partialArgs: tcAcc.input });
		}

		// 所有工具入队完成（含截断 write 补全），标记 producer 结束
		scheduler.seal();

		if (toolCallsForMsg.length === 0 && truncatedCalls.length === 0) {
			// 极端情况：有 seenTool 但都无法解析
			continue;
		}

		const toolCallMsg: AssistantToolCallMessage = {
			type: "assistant_tool_call",
			content: assistantMsg.content,
			reasoning: assistantMsg.reasoningText,
			reasoningSignature: assistantMsg.reasoningSignature,
			toolCalls: toolCallsForMsg,
			truncatedCalls: truncatedCalls.length > 0 ? truncatedCalls : undefined,
		};
		messages.push(toolCallMsg);

		// ── FIFO 渲染缓冲：等待执行完成 + 按原始顺序输出 ──
		// renderBuffer 在 streaming 开始前已创建并关联 scheduler，
		// 所有 enqueue 的工具已自动 register 到 buffer。scheduler.seal() 已同步 seal buffer。
		const drainPromise = renderBuffer.drain(renderer, () => {}, options?.signal);
		await Promise.all([runPromise, drainPromise]);

		// ── 按原始顺序 push domain messages ──
		for (const job of scheduler.orderedJobs()) {
			if (job.argError) {
				messages.push(job.argError);
			} else if (job.result) {
				messages.push(job.result);
			}
		}

		// ── 截断 write 的提示（文件已写入，但 content 不完整） ──
		for (const path of completedTruncatedWritePaths) {
			messages.push({
				type: "user_text",
				content:
					`Your write to \`${path}\` was truncated due to max_tokens limit. ` +
					`The file has been written with the partial content received so far. ` +
					`Use edit to append/fix the remaining content, or rewrite in smaller chunks.`,
			});
		}

		// ── 非 write 截断工具的 truncated 消息（作为 tool response） ──
		for (const tc of truncatedCalls) {
			messages.push({
				type: "tool_call:truncated",
				tool: tc.tool,
				callId: tc.id,
				reason: (streamInterrupted as "length" | "error" | "aborted") ?? "length",
				partialArgs: tc.partialArgs,
			});
		}

		// ── submit 处理 ──
		let earlyReturn: AgentResult<T> | null = null;
		for (const job of scheduler.orderedJobs()) {
			if (!job.result || job.result.tool !== "submit") continue;
			const validation = validateSubmit(
				job.result.cleanedResult,
				options?.schema,
			);
			if (validation.ok) {
				renderer.submitAccepted();
				earlyReturn = {
					result: validation.value,
					report: job.result.call.args.report ?? null,
					history: messages,
				};
			} else {
				submitRetries++;
				if (submitRetries >= MAX_SUBMIT_RETRIES) {
					renderer.submitRejected(
						submitRetries,
						MAX_SUBMIT_RETRIES,
						`giving up after ${submitRetries} attempts`,
					);
					earlyReturn = {
						result: null,
						report: `Submit validation failed after ${MAX_SUBMIT_RETRIES} retries: ${validation.error}`,
						history: messages,
					};
				} else {
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
				}
			}
			break;
		}

		if (earlyReturn) return earlyReturn;
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

/**
 * 尝试从截断的 write 工具 JSON 参数中提取 path 和 content。
 *
 * write 的参数格式为 {"path":"...","content":"..."}。
 * 当 content 被 max_tokens 截断时，JSON 不完整，但 path 和部分 content 仍可恢复。
 * 返回 null 表示无法提取（path 未找到）。
 * 注意：当前只处理基础 JSON 转义（\n \t \r \" \\），未处理 \uXXXX unicode 转义。如果未来遇到 content 中包含 unicode 转义导致写入乱码的情况，再增加 \uXXXX 解码。
 */
function tryExtractPartialWrite(
	partialJson: string,
): { path: string; content: string } | null {
	// 尝试正则提取 path 字段
	const pathMatch = partialJson.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
	if (!pathMatch?.[1]) return null;

	const path = pathMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	if (!path) return null;

	// 尝试提取 content 字段（可能不完整）
	const contentStart = partialJson.indexOf('"content"');
	if (contentStart === -1) return { path, content: "" };

	// 找到 content 值的起始引号
	const valueStart = partialJson.indexOf('"', contentStart + '"content"'.length + 1);
	if (valueStart === -1) return { path, content: "" };

	// 提取从起始引号之后到末尾的内容，尝试解码 JSON 字符串转义
	const rawContent = partialJson.slice(valueStart + 1);
	// 移除末尾可能的不完整转义序列
	const cleaned = rawContent.replace(/\\?$/, "");
	// 解码常见 JSON 转义
	const content = cleaned
		.replace(/\\n/g, "\n")
		.replace(/\\t/g, "\t")
		.replace(/\\r/g, "\r")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");

	return { path, content };
}
