/**
 * StreamingParser — 流式 LLM 输出的结构化解析器
 *
 * 职责：消费 LLMClient.stream() 的原始 StreamEvent，内聚 phase tracking
 * 和工具调用 JSON 完整性检测，向外 yield 语义明确的高层事件。
 *
 * 不知道 Renderer、Scheduler 的存在。纯输入→输出映射。
 */

import type { StreamEvent, ToolCallRecord } from "@n0n/types";
import { FinishReason, StreamAccumulator } from "@n0n/types";
import { isValidToolCall, parseToolCalls } from "./tool.ts";

// ── 输出事件（判别联合） ──

export type ParsedStreamEvent =
	| { type: "thinking_start" }
	| { type: "thinking_chunk"; text: string }
	| { type: "thinking_end" }
	| { type: "content_start" }
	| { type: "content_chunk"; text: string }
	| { type: "content_end" }
	| { type: "tool_arg_start"; index: number; name: string }
	| { type: "tool_arg_chunk"; index: number; chunk: string }
	| { type: "tool_ready"; index: number; tc: ToolCallRecord }
	| { type: "error"; error: string }
	| { type: "done"; result: StreamingResult };

/** 一轮 streaming 完成后的汇总 */
export interface StreamingResult {
	/** 累积器快照（toMessage, content, reasoning 等） */
	accumulator: StreamAccumulator;
	/** 已就绪的工具调用（index → ToolCallRecord），streaming 中已 yield 过 tool_ready */
	readyTools: Map<number, ToolCallRecord>;
	/** 中断原因（null = 正常结束） */
	interrupt: "length" | "error" | "aborted" | null;
	/** error 中断时的原始错误消息 */
	errorMessage?: string;
}

// ── 解析器 ──

/**
 * 消费 LLM stream，yield 结构化事件。
 *
 * 调用方（loop）遍历事件做分发：
 * - thinking/content → renderer
 * - tool_ready → scheduler.enqueue
 * - done → 进入后处理阶段
 */
export async function* parseStream(
	stream: AsyncGenerator<StreamEvent>,
	signal?: AbortSignal,
): AsyncGenerator<ParsedStreamEvent> {
	const acc = new StreamAccumulator();
	const readyTools = new Map<number, ToolCallRecord>();

	let phase: "idle" | "thinking" | "content" | "tool_args" = "idle";
	const seenIndices = new Set<number>();
	const completedIndices = new Set<number>();
	let interrupt: "length" | "error" | "aborted" | null = null;
	let errorMessage: string | undefined;

	for await (const event of stream) {
		if (signal?.aborted) {
			interrupt = "aborted";
			break;
		}

		acc.push(event);

		switch (event.type) {
			case "thinking":
				if (phase !== "thinking") {
					phase = "thinking";
					yield { type: "thinking_start" };
				}
				yield { type: "thinking_chunk", text: event.text };
				break;

			case "content":
				if (phase === "thinking") {
					yield { type: "thinking_end" };
				}
				if (phase !== "content") {
					phase = "content";
					yield { type: "content_start" };
				}
				yield { type: "content_chunk", text: event.text };
				break;

			case "tool_call_delta": {
				if (phase === "thinking") yield { type: "thinking_end" };
				if (phase === "content") yield { type: "content_end" };
				phase = "tool_args";

				if (!seenIndices.has(event.index)) {
					seenIndices.add(event.index);
					yield {
						type: "tool_arg_start",
						index: event.index,
						name: event.name ?? "?",
					};
				}
				yield {
					type: "tool_arg_chunk",
					index: event.index,
					chunk: event.arguments,
				};

				// JSON 完整性检测 → yield tool_ready
				if (!completedIndices.has(event.index)) {
					const tcAcc = acc.toolCalls.get(event.index);
					if (tcAcc) {
						try {
							JSON.parse(tcAcc.input);
							completedIndices.add(event.index);
							const parsed = parseToolCalls([tcAcc]);
							const parsedTc = parsed[0];
							if (parsedTc && isValidToolCall(parsedTc)) {
								readyTools.set(event.index, parsedTc);
								yield { type: "tool_ready", index: event.index, tc: parsedTc };
							}
						} catch {
							// JSON 尚未完整
						}
					}
				}
				break;
			}

			case "error":
				if (phase === "thinking") yield { type: "thinking_end" };
				interrupt = "error";
				errorMessage = event.error;
				yield { type: "error", error: event.error };
				break;

			case "thinking_signature":
			case "done":
				// Handled by acc.push(event) above
				break;

			default: {
				const _exhaustive: never = event;
				break;
			}
		}
	}

	// 关闭未结束的 phase
	if (phase === "content") yield { type: "content_end" };
	if (phase === "thinking") yield { type: "thinking_end" };

	// 检查 finishReason
	if (!interrupt) {
		if (acc.finishReason === FinishReason.LENGTH) interrupt = "length";
	}

	yield {
		type: "done",
		result: { accumulator: acc, readyTools, interrupt, errorMessage },
	};
}
