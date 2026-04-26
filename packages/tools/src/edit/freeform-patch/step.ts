/**
 * Freeform Patch — 编辑器循环的单步无副作用执行
 *
 * 职责：从当前状态出发，执行一轮 OpenAI Responses API 调用，
 * 返回所有可观测信息（thinking、回复、工具调用、token 用量）。
 * 不管理循环状态，不修改外部状态。
 */

import type { StreamEvent } from "@n0n/types";
import { ALL_TOOLS, FIRST_ROUND_TOOLS } from "./grammar.ts";
import type { ResponsesClient, ResponsesResult } from "./index.ts";
import { applyPatchToSource, parsePatch } from "./parser.ts";

export const MAX_ROUNDS = 25;

// ── Token 用量类型 ──

export interface UsageInfo {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	/** API 返回的 snake_case 字段 */
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	cache_read_tokens?: number;
	cache_write_tokens?: number;
	prompt_cache_hit_tokens?: number;
	prompt_cache_miss_tokens?: number;
}

// ── 输入/输出类型 ──

export interface StepInput {
	/** 当前对话历史 */
	conversation: unknown[];
	/** 当前文件内容 */
	content: string;
	/** Responses API Client */
	client: ResponsesClient;
	/** 当前轮次编号（0-based） */
	round: number;
	/** 是否已有 patch 被应用过 */
	patchAlreadyApplied: boolean;
	/** 取消信号 */
	signal?: AbortSignal;
	/** 事件回调 */
	onEvent?: (round: number, event: StreamEvent) => void;
	/** 工具结果回调 */
	onToolResult?: (round: number, summary: string) => void;
}

export interface PatchToolCall {
	name: string;
	rawInput: string;
	callId: string;
}

export interface StepResult {
	/** 更新后的对话历史 */
	conversation: unknown[];
	/** 更新后的文件内容 */
	content: string;
	/** 本次调用的工具列表 */
	toolCalls: PatchToolCall[];
	/** 是否有新的 patch 被应用 */
	patchAppliedThisRound: boolean;
	/** token 用量 */
	tokenUsage: UsageInfo | null;
	/** 是否提交 */
	hasSubmit: boolean;
	/** submit 反馈 */
	feedback: string | null;
	/** 错误信息 */
	error?: string;
}

// ── 单步执行 ──

export async function step(input: StepInput): Promise<StepResult> {
	const {
		conversation,
		content,
		client,
		round,
		signal,
		onEvent,
		onToolResult,
	} = input;
	let current = content;
	let patchAppliedThisRound = false;

	if (signal?.aborted) {
		return {
			conversation,
			content: current,
			toolCalls: [],
			patchAppliedThisRound: false,
			tokenUsage: null,
			hasSubmit: false,
			feedback: null,
			error: "Aborted",
		};
	}

	onEvent?.(round, { type: "thinking", text: `round ${round + 1}...` });

	const tools = round === 0 ? FIRST_ROUND_TOOLS : ALL_TOOLS;

	// ── 1. LLM 调用 ──

	const json = await client.create(conversation, tools, signal);

	if ("error" in json && typeof json.error === "string") {
		return {
			conversation,
			content: current,
			toolCalls: [],
			patchAppliedThisRound: false,
			tokenUsage: null,
			hasSubmit: false,
			feedback: null,
			error: json.error,
		};
	}

	if (
		!json ||
		typeof json !== "object" ||
		!("output" in json) ||
		!Array.isArray(json.output)
	) {
		return {
			conversation,
			content: current,
			toolCalls: [],
			patchAppliedThisRound: false,
			tokenUsage: null,
			hasSubmit: false,
			feedback: null,
			error: "Invalid API response format",
		};
	}

	const response = json as ResponsesResult & { usage?: UsageInfo };
	const usageInfo: UsageInfo | null = response.usage ?? null;
	// 发出 done 事件传递 token 用量
	if (usageInfo) {
		onEvent?.(round, {
			type: "done",
			finishReason: "stop",
			usage: {
				inputTokens: usageInfo.input_tokens ?? usageInfo.inputTokens ?? 0,
				outputTokens: usageInfo.output_tokens ?? usageInfo.outputTokens ?? 0,
				totalTokens: usageInfo.total_tokens ?? usageInfo.totalTokens ?? 0,
				cacheReadTokens:
					usageInfo.cache_read_tokens ?? usageInfo.prompt_cache_hit_tokens ?? 0,
				cacheWriteTokens:
					usageInfo.cache_write_tokens ??
					usageInfo.prompt_cache_miss_tokens ??
					0,
			},
		});
	}

	// ── 2. 处理工具调用 ──

	const toolCalls: PatchToolCall[] = [];
	let hasSubmit = false;
	let feedback: string | null = null;

	for (const item of response.output) {
		if (item.type !== "custom_tool_call") continue;

		const raw = item.input ?? "";
		const callId = item.call_id ?? "";
		const name = item.name ?? "unknown";

		toolCalls.push({ name, rawInput: raw, callId });

		switch (name) {
			case "apply_patch": {
				onToolResult?.(round, `apply_patch (${raw.split("\n").length} lines)`);

				const hunk = parsePatch(raw);
				if ("error" in hunk) {
					pushResult(conversation, item, `Error: ${hunk.error}`);
					break;
				}

				const result = applyPatchToSource(current, hunk);
				if (typeof result !== "string") {
					pushResult(conversation, item, `Error: ${result.error}`);
					break;
				}

				current = result;
				patchAppliedThisRound = true;
				pushResult(conversation, item, "OK: Patch applied.");
				break;
			}

			case "view_file": {
				const lines = current.split("\n");
				const { start, end } = parseRange(raw.trim(), lines.length);
				const numbered = lines
					.slice(start - 1, end)
					.map((l, i) => `${start + i}| ${l}`)
					.join("\n");
				const content = `<source_file lines="${start}-${end}" total="${lines.length}">\n${numbered}\n</source_file>`;
				onToolResult?.(round, `view_file → L${start}-${end}`);
				pushResult(conversation, item, content);
				break;
			}

			case "submit": {
				feedback = raw.trim() || null;
				hasSubmit = true;
				onToolResult?.(round, feedback ? `submit\n  ${feedback}` : "submit");
				break;
			}
		}
	}

	return {
		conversation,
		content: current,
		toolCalls,
		patchAppliedThisRound,
		tokenUsage: usageInfo,
		hasSubmit,
		feedback,
		error: undefined,
	};
}

// ── 辅助函数 ──

function pushResult(
	conversation: unknown[],
	item: { type?: string; call_id?: string; input?: string },
	output: string,
) {
	conversation.push(item);
	conversation.push({
		type: "custom_tool_call_output",
		call_id: item.call_id,
		output,
	});
}

function parseRange(
	raw: string,
	totalLines: number,
): { start: number; end: number } {
	if (!raw) return { start: 1, end: totalLines };

	const tailMatch = raw.match(/^-(\d+)$/);
	if (tailMatch) {
		const n = Number.parseInt(tailMatch[1] ?? "", 10);
		return { start: Math.max(1, totalLines - n + 1), end: totalLines };
	}

	const rangeMatch = raw.match(/^(\d+)[~-](\d+)$/);
	if (rangeMatch) {
		const s = Number.parseInt(rangeMatch[1] ?? "", 10);
		const e = Number.parseInt(rangeMatch[2] ?? "", 10);
		return { start: Math.max(1, s), end: Math.min(totalLines, e) };
	}

	return { start: 1, end: totalLines };
}
