/**
 * edit 工具 — 影子编辑（Shadow Edit）
 *
 * 主模型用自由文本表达编辑意图（intent），影子层（Editor LLM）
 * 负责理解意图并生成精确的 search/replace 操作来修改文件。
 *
 * 架构：主模型 → intent → editorLoop(Editor LLM) → str_replace × N → 文件
 *
 * 设计原则：
 * - 内容即地址：用内容本身定位，而非外部坐标
 * - 意图驱动：主模型只需表达"改什么"，不需要关心"怎么精确定位"
 * - 验证闭环：返回变更后的最终状态给主模型确认
 * - 运行时反馈：Editor LLM 通过 submit 反馈指令质量，动态引导主模型
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
	DiffChunk,
	DiffLine,
	EditDiff,
	EditToolCall,
	EditToolResult,
	LLMClient,
	ToolDefinition,
	ToolOutputChunk,
	ToolStreamEvent,
} from "@n0n/types";
import editDescription from "./edit.md" with { type: "text" };
import { applySingleOp, editorLoop } from "./editor-loop.ts";

export { EditArgsSchema } from "@n0n/types";
export { editorLoop } from "./editor-loop.ts";

// ── 主模型工具定义（intent 驱动） ──

export const EDIT_TOOL_DEFINITION: ToolDefinition = {
	name: "edit",
	description: editDescription,
	parameters: {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "File path relative to project root",
			},
			intent: {
				type: "string",
				description:
					"Edit intent in free-form text: natural language description, code snippets, or a mix of both. Describe what to change and where.",
			},
		},
		required: ["path", "intent"],
		additionalProperties: false,
	},
};

// ── Types ──

interface SearchReplaceOp {
	search: string;
	replace: string;
}

// ── applyOps（兼容测试用） ──

/**
 * 应用 search/replace 操作序列到源文件内容。
 */
export function applyOps(
	source: string,
	ops: SearchReplaceOp[],
): { content: string; applied: number; errors: string[] } {
	let content = source;
	let applied = 0;
	const errors: string[] = [];

	for (const op of ops) {
		const result = applySingleOp(content, op.search, op.replace);
		if (result.ok) {
			content = result.content;
			applied++;
		} else {
			errors.push(result.error);
		}
	}

	return { content, applied, errors };
}

// ── computeDiff ──

/**
 * 计算两个文本之间的结构化 diff。
 * 返回 EditDiff 对象，包含变更块列表和增删行数统计。
 */
export function computeDiff(oldContent: string, newContent: string): EditDiff {
	if (oldContent === newContent) {
		return { chunks: [], added: 0, removed: 0 };
	}

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const chunks: DiffChunk[] = [];
	let totalAdded = 0;
	let totalRemoved = 0;

	let i = 0;
	let j = 0;

	while (i < oldLines.length || j < newLines.length) {
		if (
			i < oldLines.length &&
			j < newLines.length &&
			oldLines[i] === newLines[j]
		) {
			i++;
			j++;
			continue;
		}

		const contextStart = Math.max(0, j - 2);

		let oldEnd = i;
		let newEnd = j;
		while (oldEnd < oldLines.length || newEnd < newLines.length) {
			if (
				oldEnd < oldLines.length &&
				newEnd < newLines.length &&
				oldLines[oldEnd] === newLines[newEnd]
			) {
				let matchCount = 0;
				while (
					oldEnd + matchCount < oldLines.length &&
					newEnd + matchCount < newLines.length &&
					oldLines[oldEnd + matchCount] === newLines[newEnd + matchCount]
				) {
					matchCount++;
					if (matchCount >= 3) break;
				}
				if (matchCount >= 3) break;
			}
			if (oldEnd < oldLines.length) oldEnd++;
			if (newEnd < newLines.length) newEnd++;
		}

		const contextEnd = Math.min(newLines.length, newEnd + 2);
		const chunkAdded = newEnd - j;
		const chunkRemoved = oldEnd - i;
		totalAdded += chunkAdded;
		totalRemoved += chunkRemoved;

		const lines: DiffLine[] = [];
		for (let c = contextStart; c < contextEnd; c++) {
			lines.push({
				line: c + 1,
				content: newLines[c] ?? "",
				changed: c >= j && c < newEnd,
			});
		}

		chunks.push({
			startLine: contextStart + 1,
			endLine: contextEnd,
			lines,
		});

		i = oldEnd;
		j = newEnd;
	}

	return { chunks, added: totalAdded, removed: totalRemoved };
}

// ── Tool Entry Points ──

const EMPTY_DIFF: EditDiff = { chunks: [], added: 0, removed: 0 };

function failResult(call: EditToolCall, error: string): EditToolResult {
	return {
		type: "tool_result",
		tool: "edit" as const,
		call,
		diff: EMPTY_DIFF,
		success: false,
		error,
		feedback: null,
		rounds: 0,
		durationMs: 0,
	};
}

export async function editTool(
	call: EditToolCall,
	workspace: string,
	editorClient: LLMClient,
): Promise<EditToolResult> {
	const filePath = isAbsolute(call.args.path)
		? call.args.path
		: resolve(workspace, call.args.path);
	const { intent } = call.args;

	try {
		if (!existsSync(filePath))
			return failResult(call, `File not found: ${call.args.path}`);
		if (!intent || intent.trim().length === 0)
			return failResult(call, "No intent provided");

		const source = readFileSync(filePath, "utf8");
		const startTime = Date.now();

		const {
			content: newContent,
			feedback,
			error,
			rounds,
		} = await editorLoop(source, intent, editorClient);

		const durationMs = Date.now() - startTime;

		if (error)
			return {
				...failResult(call, error),
				feedback: feedback ?? null,
				rounds,
				durationMs,
			};

		writeFileSync(filePath, newContent, "utf8");
		const diff = computeDiff(source, newContent);

		return {
			type: "tool_result",
			tool: "edit" as const,
			call,
			diff,
			success: true,
			error: null,
			feedback: feedback ?? null,
			rounds,
			durationMs,
		};
	} catch (err) {
		return failResult(call, err instanceof Error ? err.message : String(err));
	}
}

/**
 * 流式版 editTool — yield ToolOutputChunk 展示 Editor LLM 中间过程，
 * 最终 yield EditToolResult。
 */
export async function* editToolStream(
	call: EditToolCall,
	workspace: string,
	editorClient: LLMClient,
): AsyncGenerator<ToolStreamEvent> {
	const filePath = isAbsolute(call.args.path)
		? call.args.path
		: resolve(workspace, call.args.path);
	const { intent } = call.args;

	try {
		if (!existsSync(filePath)) {
			yield failResult(call, `File not found: ${call.args.path}`);
			return;
		}
		if (!intent || intent.trim().length === 0) {
			yield failResult(call, "No intent provided");
			return;
		}

		const source = readFileSync(filePath, "utf8");
		const startTime = Date.now();

		// Async queue 桥接 onEvent → yield
		const queue: string[] = [];
		let notify: (() => void) | null = null;
		let done = false;

		const push = (text: string) => {
			queue.push(text);
			notify?.();
		};

		let lastRound = -1;
		const onEvent = (
			round: number,
			_event: import("@n0n/types").StreamEvent,
		) => {
			if (round !== lastRound) {
				push(`[round ${round + 1}]\n`);
				lastRound = round;
			}
		};

		const onToolResult = (_round: number, summary: string) => {
			push(`  ${summary}\n`);
		};

		const loopPromise = editorLoop(
			source,
			intent,
			editorClient,
			onEvent,
			onToolResult,
		).then((result) => {
			done = true;
			notify?.();
			return result;
		});

		// 从 queue yield chunks
		while (!done) {
			if (queue.length > 0) {
				const text = queue.splice(0, queue.length).join("");
				yield {
					type: "tool_output_chunk",
					callId: call.id,
					tool: "edit",
					chunk: text,
				} satisfies ToolOutputChunk;
			} else {
				await new Promise<void>((r) => {
					notify = r;
				});
			}
		}
		// flush 剩余
		if (queue.length > 0) {
			yield {
				type: "tool_output_chunk",
				callId: call.id,
				tool: "edit",
				chunk: queue.join(""),
			} satisfies ToolOutputChunk;
		}

		const { content: newContent, feedback, error, rounds } = await loopPromise;
		const durationMs = Date.now() - startTime;

		if (error) {
			yield {
				...failResult(call, error),
				feedback: feedback ?? null,
				rounds,
				durationMs,
			};
			return;
		}

		writeFileSync(filePath, newContent, "utf8");
		const diff = computeDiff(source, newContent);

		yield {
			type: "tool_result",
			tool: "edit" as const,
			call,
			diff,
			success: true,
			error: null,
			feedback: feedback ?? null,
			rounds,
			durationMs,
		};
	} catch (err) {
		yield failResult(call, err instanceof Error ? err.message : String(err));
	}
}
