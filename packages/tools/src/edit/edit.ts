/**
 * edit 工具 — 影子编辑（Shadow Edit）
 *
 * 主模型用自由文本表达编辑意图（intent），影子层（Editor LLM）
 * 负责理解意图并生成精确的 search/replace 操作来修改文件。
 *
 * 架构：主模型 → intent → EditBackend.execute() → 文件修改
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
	EditArgs,
	EditToolCall,
	EditToolResult,
	PatchOp,
	ToolDefinition,
	ToolOutputChunk,
	ToolStreamEvent,
} from "@n0n/types";
import { EditArgsSchema } from "@n0n/types";
import {
	type FieldDescriptions,
	zodToParameters,
} from "../zod-to-parameters.ts";
import type { EditBackend } from "./backend.ts";
import editDescription from "./edit.md" with { type: "text" };

export { EditArgsSchema };

const editDescriptions: FieldDescriptions<EditArgs> = {
	path: "File path relative to project root",
	intent:
		"Edit intent in free-form text: natural language description, code snippets, or a mix of both. Describe what to change and where.",
};

// ── 主模型工具定义（intent 驱动） ──
export const EDIT_TOOL_DEFINITION: ToolDefinition = {
	name: "edit",
	description: editDescription,
	parameters: zodToParameters(EditArgsSchema, editDescriptions),
};

// ── Tool Entry Points ──

function failResult(call: EditToolCall, error: string): EditToolResult {
	return {
		type: "tool_result",
		tool: "edit" as const,
		call,
		patches: [],
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
	backend: EditBackend,
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
			patches,
		} = await backend.execute(source, intent);

		const durationMs = Date.now() - startTime;

		if (error)
			return {
				...failResult(call, error),
				feedback: feedback ?? null,
				rounds,
				durationMs,
			};

		writeFileSync(filePath, newContent, "utf8");

		return {
			type: "tool_result",
			tool: "edit" as const,
			call,
			patches,
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
	backend: EditBackend,
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

		const loopPromise = backend
			.execute(source, intent, {
				onEvent,
				onToolResult,
			})
			.then((result) => {
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

		const { content: newContent, feedback, error, rounds, patches } = await loopPromise;
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

		yield {
			type: "tool_result",
			tool: "edit" as const,
			call,
			patches,
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
