/**
 * RichRenderer — 富终端 UI 渲染器
 *
 * 彩色角色标签、流式 thinking/content、结构化工具参数显示、
 * 流式工具输出（exec stdout/stderr 实时）、LiveRegion 行替换。
 */

import type { Renderer, ToolCallRecord, ToolResult } from "@n0n/types";
import { parse as parsePartialJSON } from "partial-json";
import { label, style, write, writeln } from "./ansi.ts";
import { LiveRegion } from "./live-region.ts";

// ── 工具参数结构化渲染 ──

/** 解析可能不完整的 JSON（LLM 流式输出），返回已解析的字段 */
function tryParseArgs(s: string): Record<string, unknown> | null {
	try {
		const parsed = parsePartialJSON(s);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {}
	return null;
}

/** 将工具参数渲染为结构化字段格式 */
function renderToolArgs(
	toolName: string,
	args: Record<string, unknown>,
): string[] {
	const lines: string[] = [];
	lines.push(`${style.dim("▸")} ${style.cyan(toolName)}`);

	const entries = Object.entries(args);
	for (const [key, value] of entries) {
		const strValue = typeof value === "string" ? value : JSON.stringify(value);
		lines.push(`  ${style.dim("├")} ${style.gray(key)}`);
		// 值可能多行，每行缩进
		const valueLines = strValue.split("\n");
		const maxLines = 12;
		for (const vl of valueLines.slice(0, maxLines)) {
			lines.push(`  ${style.dim("│")} ${vl}`);
		}
		if (valueLines.length > maxLines) {
			lines.push(
				style.gray(
					`  ${style.dim("│")} ... (${valueLines.length - maxLines} more lines)`,
				),
			);
		}
	}
	lines.push(`  ${style.dim("├")}${style.dim("─".repeat(30))}`);
	return lines;
}

export class RichRenderer implements Renderer {
	private toolRegion = new LiveRegion();
	private hasStreamContent = false;
	private isThinking = false;
	/** 流式阶段已渲染参数的工具数量（跳过对应数量的 toolCallStart） */
	private skipToolCallStarts = 0;

	/** 流式工具调用参数累积（index → { name, args }） */
	private streamingToolCalls = new Map<
		number,
		{ name: string; args: string }
	>();
	/** 流式工具调用参数的 LiveRegion（流式阶段使用，执行阶段折叠） */
	private streamRegion = new LiveRegion();

	userMessage(content: string): void {
		writeln();
		writeln(label.user());
		writeln(content);
	}

	roundStart(round: number, maxRounds: number, msgCount: number): void {
		writeln();
		write(label.agent());
		writeln(style.gray(`  round ${round}/${maxRounds} (${msgCount} msgs)`));
	}

	thinkingToken(token: string): void {
		write(style.gray(token));
		this.hasStreamContent = true;
		this.isThinking = true;
	}

	contentToken(token: string): void {
		// thinking → content 切换时加换行分隔
		if (this.isThinking) {
			writeln();
			this.isThinking = false;
		}
		write(token);
		this.hasStreamContent = true;
	}

	contentEnd(): void {
		if (this.hasStreamContent) {
			writeln();
			this.hasStreamContent = false;
		}
		this.isThinking = false;
		// 折叠流式工具调用参数区域 → 替换为解析后的结构化显示
		if (this.streamingToolCalls.size > 0) {
			this.streamRegion.clear();
			for (const [, tc] of [...this.streamingToolCalls.entries()].sort(
				(a, b) => a[0] - b[0],
			)) {
				const parsed = tryParseArgs(tc.args);
				if (parsed) {
					for (const line of renderToolArgs(tc.name, parsed)) {
						this.streamRegion.writeln(line);
					}
				} else {
					this.streamRegion.writeln(
						`${style.dim("▸")} ${style.cyan(tc.name)} ${style.gray(tc.args.slice(0, 80))}`,
					);
				}
			}
			this.skipToolCallStarts = this.streamingToolCalls.size;
			this.streamingToolCalls.clear();
			// 结构化参数已提交到终端，重置行计数防止后续 clear() 误删已提交行
			this.streamRegion.reset();
		}
	}

	textResponse(content: string, idleCount: number): void {
		if (content) {
			writeln(content);
		}
		writeln(
			style.gray(`(text response, ${content.length} chars, idle=${idleCount})`),
		);
	}

	toolCallStart(tc: ToolCallRecord): void {
		this.toolRegion.reset();
		// 如果 streamRegion 已经渲染了结构化参数，不重复渲染
		// toolCallStart 只在 streamRegion 为空时（非流式回退）渲染
		if (this.skipToolCallStarts > 0) {
			this.skipToolCallStarts--;
			return;
		}

		// 非流式回退：直接渲染结构化参数
		for (const line of renderToolArgs(tc.tool, tc.args)) {
			this.toolRegion.writeln(line);
		}
	}

	toolCallArgChunk(
		index: number,
		name: string | undefined,
		chunk: string,
	): void {
		// 首次 chunk 前确保换行（避免粘在 content 后面）
		if (this.hasStreamContent) {
			writeln();
			this.hasStreamContent = false;
		}

		// 累积参数
		let entry = this.streamingToolCalls.get(index);
		if (!entry) {
			entry = { name: name ?? "?", args: "" };
			this.streamingToolCalls.set(index, entry);
		}
		if (name) entry.name = name;
		entry.args += chunk;

		// 重绘整个流式区域：尝试解析 JSON，成功则结构化显示，否则显示原始
		this.streamRegion.clear();
		for (const [, tc] of [...this.streamingToolCalls.entries()].sort(
			(a, b) => a[0] - b[0],
		)) {
			const parsed = tryParseArgs(tc.args);
			if (parsed && Object.keys(parsed).length > 0) {
				for (const line of renderToolArgs(tc.name, parsed)) {
					this.streamRegion.writeln(line);
				}
			} else {
				this.streamRegion.writeln(
					`${style.dim("▸")} ${style.cyan(tc.name)} ${style.gray("(streaming...")}`,
				);
			}
		}
	}

	/** 流式工具输出 chunk（exec stdout/stderr 实时显示） */
	toolResultChunk(_tool: string, chunk: string): void {
		// 逐 chunk 追加到 toolRegion
		for (const line of chunk.split("\n")) {
			if (line) {
				this.toolRegion.writeln(`  ${style.dim("│")} ${style.dim(line)}`);
			}
		}
	}

	toolCallEnd(result: ToolResult): void {
		const summary = this.formatToolResult(result);
		// 所有工具：保留已显示的结构化参数，追加摘要行
		writeln(summary);
	}

	submitAccepted(): void {
		writeln();
		writeln(
			`${style.bgGreen(style.bold(" ✔ DONE "))} ${style.green("submit accepted")}`,
		);
	}

	submitRejected(attempt: number, maxAttempts: number, error: string): void {
		writeln(
			`${style.red("✗")} submit rejected (${attempt}/${maxAttempts}): ${style.gray(error)}`,
		);
	}

	agentTerminated(reason: string): void {
		writeln();
		writeln(`${style.yellow("⚠")} ${style.gray(reason)}`);
	}

	aborted(): void {
		// 清理流式输出状态
		if (this.hasStreamContent) {
			writeln();
			this.hasStreamContent = false;
		}
		this.isThinking = false;
		this.streamingToolCalls.clear();
		this.streamRegion.reset();
		this.toolRegion.reset();
		this.skipToolCallStarts = 0;
		writeln();
		writeln(`${style.yellow("⚡")} ${style.gray("已中断输出")}`);
	}

	// ── 工具结果格式化（紧凑摘要行） ──

	private formatToolResult(result: ToolResult): string {
		switch (result.tool) {
			case "exec": {
				const duration = style.gray(
					`${(result.durationMs / 1000).toFixed(1)}s`,
				);
				const exit =
					result.exitCode === 0
						? style.green(`exit=${result.exitCode}`)
						: style.red(`exit=${result.exitCode}`);
				const outLen = result.stdout.length + result.stderr.length;
				return `${style.dim("◂")} ${style.cyan("exec")} ${duration} ${exit} ${style.gray(`${outLen} chars`)}`;
			}
			case "write": {
				if (!result.success) {
					return `${style.dim("◂")} ${style.cyan("write")} ${result.call.args.path}: ${style.red(result.error ?? "failed")}`;
				}
				return `${style.dim("◂")} ${style.cyan("write")} ${result.call.args.path}`;
			}
			case "edit": {
				if (!result.success) {
					return `${style.dim("◂")} ${style.cyan("edit")} ${result.call.args.path}: ${style.red(result.error ?? "failed")}`;
				}
				const cmdLines = result.call.args.commands.split("\n").length;
				return `${style.dim("◂")} ${style.cyan("edit")} ${result.call.args.path} ${style.gray(`(${cmdLines} line(s) of vim cmds)`)}`;
			}
			case "reminder": {
				return `${style.dim("◂")} ${style.cyan("reminder")} ${style.gray(`(in ${result.call.args.delay} rounds)`)} ${style.gray(`${result.call.args.content.length} chars`)}`;
			}
			case "submit": {
				return `${style.dim("◂")} ${style.cyan("submit")}`;
			}
		}
	}
}
