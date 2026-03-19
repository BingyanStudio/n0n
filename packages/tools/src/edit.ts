/**
 * edit 工具 — 影子编辑（Shadow Edit）
 *
 * 主模型用自由文本表达编辑意图（intent），影子层（Editor LLM）
 * 负责理解意图并生成精确的 search/replace 操作来修改文件。
 *
 * 架构：主模型 → intent → editorLoop(Editor LLM) → str_replace × N → 文件
 *
 * Editor LLM 工具集（完全封装在 edit.ts 内部，不依赖 @n0n/core）：
 * - str_replace(old_string, new_string): 单次精确替换
 * - view_file(): 读取当前文件状态
 * - submit(feedback?): 提交完成 + 可选反馈，退出循环
 *
 * 设计原则：
 * - 内容即地址：用内容本身定位，而非外部坐标
 * - 意图驱动：主模型只需表达"改什么"，不需要关心"怎么精确定位"
 * - 验证闭环：返回变更后的最终状态给主模型确认
 * - 运行时反馈：Editor LLM 通过 submit 反馈指令质量，动态引导主模型
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { LLMConfig } from "@n0n/llm";
import { chatCompletionStream, StreamAccumulator } from "@n0n/llm";
import type {
	DiffChunk,
	DiffLine,
	EditDiff,
	EditToolCall,
	EditToolResult,
	LLMRequestMessage,
	LLMToolDefinition,
	ToolOutputChunk,
	ToolStreamEvent,
} from "@n0n/types";
import editDescription from "./descriptions/edit.md" with { type: "text" };
import editorAgentPrompt from "./descriptions/editor-agent.md" with {
	type: "text",
};

export { EditArgsSchema } from "@n0n/types";

// ── 主模型工具定义（intent 驱动） ──

export const EDIT_TOOL_DEFINITION: LLMToolDefinition = {
	type: "function",
	function: {
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
	},
};

// ── Editor LLM 内部工具定义 ──

const STR_REPLACE_TOOL: LLMToolDefinition = {
	type: "function",
	function: {
		name: "str_replace",
		description:
			"Replace an exact substring in the file. The old_string must match character-for-character (including whitespace). Use the minimal unique fragment needed to identify the location.",
		parameters: {
			type: "object",
			properties: {
				old_string: {
					type: "string",
					description:
						"Exact substring to find in the current file content",
				},
				new_string: {
					type: "string",
					description:
						"Replacement text. Use empty string for deletions.",
				},
			},
			required: ["old_string", "new_string"],
			additionalProperties: false,
		},
	},
};

const VIEW_FILE_TOOL: LLMToolDefinition = {
	type: "function",
	function: {
		name: "view_file",
		description:
			"View the current file content after previous edits. Use this to verify the file state before making further changes.",
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
};

const SUBMIT_TOOL: LLMToolDefinition = {
	type: "function",
	function: {
		name: "submit",
		description:
			"Submit when all edits are complete. Optionally provide feedback on the caller's intent quality.",
		parameters: {
			type: "object",
			properties: {
				feedback: {
					type: "string",
					description:
						"Optional feedback if the caller's intent could be improved: over-specified (contains line numbers/verbatim code), too large (should split), or too vague (cannot locate target). Omit if intent is clear.",
				},
			},
			additionalProperties: false,
		},
	},
};

const EDITOR_TOOLS: LLMToolDefinition[] = [
	STR_REPLACE_TOOL,
	VIEW_FILE_TOOL,
	SUBMIT_TOOL,
];

// ── Types ──

interface SearchReplaceOp {
	search: string;
	replace: string;
}

/** Editor LLM 最大循环轮数 */
const MAX_ROUNDS = 15;

// ── Core Logic: applyOps ──

/**
 * 应用单次 search/replace 操作到源文件内容。
 * 返回 { ok, content?, error? }。
 */
function applySingleOp(
	source: string,
	oldStr: string,
	newStr: string,
): { ok: true; content: string } | { ok: false; error: string } {
	// 归一化换行符：LLM 生成的 old_string 总是 \n，但源文件可能是 \r\n
	const useCrlf = source.includes("\r\n");
	const normSource = useCrlf ? source.replace(/\r\n/g, "\n") : source;
	const normOld = oldStr.replace(/\r\n/g, "\n");

	const idx = normSource.indexOf(normOld);
	if (idx === -1) {
		const preview =
			normOld.length > 80 ? `${normOld.slice(0, 80)}...` : normOld;
		return { ok: false, error: `Search text not found: "${preview}"` };
	}

	const secondIdx = normSource.indexOf(normOld, idx + 1);
	if (secondIdx !== -1) {
		const preview =
			normOld.length > 80 ? `${normOld.slice(0, 80)}...` : normOld;
		return {
			ok: false,
			error: `Search text matches multiple locations: "${preview}"`,
		};
	}

	// 适配替换文本的换行风格
	const normNew = useCrlf
		? newStr.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n")
		: newStr.replace(/\r\n/g, "\n");

	const content =
		normSource.slice(0, idx) + normNew + normSource.slice(idx + normOld.length);

	// 恢复原始换行风格
	return { ok: true, content: useCrlf ? content.replace(/\n/g, "\r\n") : content };
}

/**
 * 应用 search/replace 操作序列到源文件内容（兼容测试用）。
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

// ── Editor Loop ──

/**
 * Editor LLM 专用循环：驱动 Editor LLM 通过 str_replace/view_file/submit
 * 完成编辑任务。完全封装在 edit.ts 内部，不依赖 @n0n/core。
 *
 * 流程：
 * 1. 发送 [system, user(source + intent)]
 * 2. Editor LLM 调用 str_replace → 执行替换 → 返回结果
 * 3. Editor LLM 调用 view_file → 返回当前文件内容
 * 4. Editor LLM 调用 submit → 提取 feedback → 退出循环
 * 5. 达到上限 → 返回最后的错误
 */
export async function editorLoop(
	source: string,
	intent: string,
	editorLlm: LLMConfig,
	onEvent?: (round: number, event: import("@n0n/llm").StreamEvent) => void,
	onToolResult?: (round: number, summary: string) => void,
): Promise<{ content: string; feedback: string | null; error: string | null; rounds: number }> {
	let current = source;
	let editCount = 0;

	const messages: LLMRequestMessage[] = [
		{ role: "system", content: editorAgentPrompt },
		{
			role: "user",
			content: [
				"<source_file>",
				source,
				"</source_file>",
				"",
				"<edit_intent>",
				intent,
				"</edit_intent>",
			].join("\n"),
		},
	];

	for (let round = 0; round < MAX_ROUNDS; round++) {
		let message: ReturnType<StreamAccumulator["toMessage"]>;
		try {
			const acc = new StreamAccumulator();
			for await (const event of chatCompletionStream(
				{
					messages,
					tools: EDITOR_TOOLS,
					tool_choice: "required",
					temperature: 0,
				},
				{ llm: editorLlm },
			)) {
				acc.push(event);
				onEvent?.(round, event);
			}
			message = acc.toMessage();
		} catch (err) {
			return {
				content: current,
				feedback: null,
				error: `Editor LLM call failed: ${err instanceof Error ? err.message : String(err)}`,
				rounds: round + 1,
			};
		}

		if (!message.tool_calls?.length) {
			// 无工具调用 — 追加提示重试
			messages.push({
				role: "assistant",
				content: message.content ?? "",
			});
			messages.push({
				role: "user",
				content:
					"You must call a tool. Use str_replace to make changes, view_file to check the file, or submit when done.",
			});
			continue;
		}

		// 追加 assistant 消息
		messages.push({
			role: "assistant",
			content: message.content,
			tool_calls: message.tool_calls?.map((tc) => ({
				id: tc.id,
				type: tc.type,
				function: tc.function,
			})),
		});

		// 逐个处理 tool_calls
		for (const tc of message.tool_calls) {
			const name = tc.function.name;
			let args: Record<string, unknown>;
			try {
				args = JSON.parse(tc.function.arguments);
			} catch {
				messages.push({
					role: "tool",
					tool_call_id: tc.id,
					content: "Error: Failed to parse tool arguments as JSON.",
				});
				onToolResult?.(round, "parse error");
				continue;
			}

			switch (name) {
				case "str_replace": {
					const oldStr = String(args.old_string ?? "");
					const newStr = String(args.new_string ?? "");

					if (!oldStr) {
						messages.push({
							role: "tool",
							tool_call_id: tc.id,
							content: "Error: old_string cannot be empty.",
						});
						onToolResult?.(round, "str_replace → old_string empty");
						break;
					}

					const result = applySingleOp(current, oldStr, newStr);
					if (result.ok) {
						current = result.content;
						editCount++;
						messages.push({
							role: "tool",
							tool_call_id: tc.id,
							content: `OK: Replacement applied (edit #${editCount}).`,
						});
						onToolResult?.(round, `str_replace → edit #${editCount}`);
					} else {
						messages.push({
							role: "tool",
							tool_call_id: tc.id,
							content: [
								`Error: ${result.error}`,
								"",
								"Check whitespace, indentation, and character-for-character accuracy.",
								"Call view_file to see the current file content.",
							].join("\n"),
						});
						onToolResult?.(round, `str_replace → ${result.error}`);
					}
					break;
				}

				case "view_file": {
					messages.push({
						role: "tool",
						tool_call_id: tc.id,
						content: `<source_file>\n${current}\n</source_file>`,
					});
					onToolResult?.(round, "view_file → ok");
					break;
				}

				case "submit": {
					const feedback =
						typeof args.feedback === "string" && args.feedback.length > 0
							? args.feedback
							: null;

					onToolResult?.(round, "submit");
					// 退出循环
					return { content: current, feedback, error: null, rounds: round + 1 };
				}

				default: {
					messages.push({
						role: "tool",
						tool_call_id: tc.id,
						content: `Error: Unknown tool "${name}". Use str_replace, view_file, or submit.`,
					});
					onToolResult?.(round, `unknown tool: ${name}`);
				}
			}
		}
	}

	return {
		content: current,
		feedback: null,
		error: `Editor LLM did not submit within ${MAX_ROUNDS} rounds (${editCount} edits applied).`,
		rounds: MAX_ROUNDS,
	};
}

// ── Diff ──

/**
 * 生成变更摘要 — 只显示变更区域的最终状态（不显示删除内容）
 */
export function computeDiff(
	oldContent: string,
	newContent: string,
): EditDiff {
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
				content: newLines[c]!,
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

// ── Tool Entry Point ──

export async function editTool(
	call: EditToolCall,
	workspace: string,
	editorLlm: LLMConfig,
): Promise<EditToolResult> {
	const filePath = isAbsolute(call.args.path)
		? call.args.path
		: resolve(workspace, call.args.path);
	const { intent } = call.args;

	const fail = (error: string): EditToolResult => ({
		type: "tool_result",
		tool: "edit" as const,
		call,
		diff: { chunks: [], added: 0, removed: 0 },
		success: false,
		error,
		feedback: null,
		rounds: 0,
		durationMs: 0,
	});

	try {
		if (!existsSync(filePath)) return fail(`File not found: ${call.args.path}`);
		if (!intent || intent.trim().length === 0)
			return fail("No intent provided");

		const source = readFileSync(filePath, "utf8");

		const startTime = Date.now();

		const { content: newContent, feedback, error, rounds } = await editorLoop(
			source,
			intent,
			editorLlm,
		);

		const durationMs = Date.now() - startTime;

		if (error) return { ...fail(error), feedback: feedback ?? null, rounds, durationMs };

		// 写入文件
		writeFileSync(filePath, newContent, "utf8");

		// 生成变更摘要
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
		return fail(err instanceof Error ? err.message : String(err));
	}
}

/**
 * 流式版 editTool — yield ToolOutputChunk 展示 Editor LLM 中间过程，
 * 最终 yield EditToolResult。
 */
export async function* editToolStream(
	call: EditToolCall,
	workspace: string,
	editorLlm: LLMConfig,
): AsyncGenerator<ToolStreamEvent> {
	const filePath = isAbsolute(call.args.path)
		? call.args.path
		: resolve(workspace, call.args.path);
	const { intent } = call.args;

	const fail = (error: string): EditToolResult => ({
		type: "tool_result",
		tool: "edit" as const,
		call,
		diff: { chunks: [], added: 0, removed: 0 },
		success: false,
		error,
		feedback: null,
		rounds: 0,
		durationMs: 0,
	});

	try {
		if (!existsSync(filePath)) {
			yield fail(`File not found: ${call.args.path}`);
			return;
		}
		if (!intent || intent.trim().length === 0) {
			yield fail("No intent provided");
			return;
		}

		const source = readFileSync(filePath, "utf8");
		const startTime = Date.now();

		// Async queue 桥接 onEvent → yield
		const queue: string[] = [];
		let resolve: (() => void) | null = null;
		let done = false;

		const push = (text: string) => {
			queue.push(text);
			resolve?.();
		};

		let lastRound = -1;
		const onEvent = (round: number, _event: import("@n0n/llm").StreamEvent) => {
			if (round !== lastRound) {
				push(`[round ${round + 1}]\n`);
				lastRound = round;
			}
		};

		const onToolResult = (_round: number, summary: string) => {
			push(`  ${summary}\n`);
		};

		// 启动 editorLoop（后台运行）
		const loopPromise = editorLoop(source, intent, editorLlm, onEvent, onToolResult).then(
			(result) => {
				done = true;
				resolve?.();
				return result;
			},
		);

		// 从 queue yield chunks
		while (!done) {
			if (queue.length > 0) {
				const text = queue.splice(0, queue.length).join("");
				yield {
					type: "tool_output_chunk",
					callId: call.id,
					tool: "edit",
					chunk: text,
				};
			} else {
				await new Promise<void>((r) => {
					resolve = r;
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
			};
		}

		const { content: newContent, feedback, error, rounds } = await loopPromise;
		const durationMs = Date.now() - startTime;

		if (error) {
			yield { ...fail(error), feedback: feedback ?? null, rounds, durationMs };
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
		yield fail(err instanceof Error ? err.message : String(err));
	}
}
