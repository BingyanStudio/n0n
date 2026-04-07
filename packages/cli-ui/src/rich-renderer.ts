/**
 * RichRenderer — 富终端 UI 渲染器（指令式事件模型）
 *
 * 彩色角色标签、流式 thinking/content、结构化工具参数显示、
 * 流式工具输出（exec stdout/stderr 实时）、LiveRegion 行替换。
 *
 * 所有阶段转换由 loop.ts 指令驱动，不维护推断状态。
 */

import { estimateTokens } from "@n0n/shared";
import type {
	Renderer,
	RoundTokenUsage,
	ToolCallRecord,
	ToolResult,
} from "@n0n/types";
import { parse as parsePartialJSON } from "partial-json";
import { isTTY, label, style, write, writeln } from "./ansi.ts";
import { LiveRegion } from "./live-region.ts";

// ── token 数值人类友好格式化 ──

/** 将 token 数量格式化为紧凑的人类可读字符串（如 1.2k, 15.3k） */
function fmtTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

/** 格式化上一轮 token 用量为紧凑摘要（用于 roundStart 行尾） */
function formatUsageSummary(usage: RoundTokenUsage): string {
	const parts: string[] = [];
	parts.push(`${fmtTokens(usage.totalTokens)} tok`);

	if (usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0) {
		const cacheParts: string[] = [];
		if (usage.cacheReadTokens > 0) {
			const totalInput =
				usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
			const hitPct =
				totalInput > 0
					? Math.round((usage.cacheReadTokens / totalInput) * 100)
					: 0;
			cacheParts.push(
				style.green(`⚡${fmtTokens(usage.cacheReadTokens)} hit ${hitPct}%`),
			);
		}
		if (usage.cacheWriteTokens > 0) {
			cacheParts.push(
				style.yellow(`✎${fmtTokens(usage.cacheWriteTokens)} write`),
			);
		}
		parts.push(cacheParts.join(" "));
	} else if (usage.inputTokens > 0) {
		parts.push(style.dim("no cache"));
	}

	return parts.join(" · ");
}

// ── 工具参数结构化渲染 ──

/** 将工具参数渲染为结构化字段格式（最终形式） */
function renderToolArgs(
	toolName: string,
	args: Record<string, unknown>,
): string[] {
	const lines: string[] = [];
	lines.push(`${style.dim("▸")} ${style.cyan(toolName)}`);

	const maxLines = 12;
	for (const [key, value] of Object.entries(args)) {
		const strValue = typeof value === "string" ? value : JSON.stringify(value);
		lines.push(`  ${style.dim("├")} ${style.gray(key)}`);
		const valueLines = strValue.split("\n");
		if (valueLines.length <= maxLines) {
			for (const vl of valueLines) {
				lines.push(`  ${style.dim("│")} ${vl}`);
			}
		} else {
			const headCount = Math.ceil(maxLines / 2);
			const tailCount = maxLines - headCount;
			for (const vl of valueLines.slice(0, headCount)) {
				lines.push(`  ${style.dim("│")} ${vl}`);
			}
			lines.push(
				style.gray(
					`  ${style.dim("│")} ... (${valueLines.length - maxLines} more lines)`,
				),
			);
			for (const vl of valueLines.slice(-tailCount)) {
				lines.push(`  ${style.dim("│")} ${vl}`);
			}
		}
	}
	lines.push(`  ${style.dim("├")}${style.dim("─".repeat(30))}`);
	return lines;
}

/** 流式阶段：尾部滚动窗口渲染 */
function renderToolArgsStreaming(
	toolName: string,
	args: Record<string, unknown>,
): string[] {
	const lines: string[] = [];
	lines.push(
		`${style.dim("▸")} ${style.cyan(toolName)} ${style.gray("(streaming…)")}`,
	);

	const maxTailLines = 6;
	for (const [key, value] of Object.entries(args)) {
		const strValue = typeof value === "string" ? value : JSON.stringify(value);
		lines.push(`  ${style.dim("├")} ${style.gray(key)}`);
		const valueLines = strValue.split("\n");
		if (valueLines.length <= maxTailLines) {
			for (const vl of valueLines) {
				lines.push(`  ${style.dim("│")} ${vl}`);
			}
		} else {
			lines.push(
				style.gray(
					`  ${style.dim("│")} ... (${valueLines.length - maxTailLines} lines above)`,
				),
			);
			for (const vl of valueLines.slice(-maxTailLines)) {
				lines.push(`  ${style.dim("│")} ${vl}`);
			}
		}
	}
	return lines;
}

/** 尝试解析可能不完整的 JSON */
function tryParseArgs(s: string): Record<string, unknown> | null {
	try {
		const parsed = parsePartialJSON(s);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {}
	return null;
}

export class RichRenderer implements Renderer {
	/** 工具执行阶段的 LiveRegion（实时输出） */
	private toolRegion = new LiveRegion();
	/** 流式工具参数的 LiveRegion（TTY 模式下实时刷新） */
	private streamRegion = new LiveRegion();

	/**
	 * 流式工具调用参数累积（index → { name, args }）
	 *
	 * 由 toolCallArgStart 创建，toolCallArgEnd 移除，streamEnd 清理残留。
	 * Renderer 不做 JSON 完整性检测——生命周期完全由上游指令驱动。
	 */
	private streamingToolCalls = new Map<
		number,
		{ name: string; args: string }
	>();

	/** 本轮是否有流式工具参数（有则 toolExecStart 不重复渲染） */
	private hadStreamingArgs = false;

	userMessage(content: string): void {
		writeln();
		writeln(label.user());
		writeln(content);
	}

	roundStart(
		round: number,
		maxRounds: number,
		msgCount: number,
		lastUsage?: RoundTokenUsage | null,
	): void {
		this.hadStreamingArgs = false;
		writeln();
		write(label.agent());

		const roundInfo = `round ${round}/${maxRounds} (${msgCount} msgs)`;
		if (lastUsage) {
			writeln(style.gray(`  ${roundInfo} · ${formatUsageSummary(lastUsage)}`));
		} else {
			writeln(style.gray(`  ${roundInfo}`));
		}
	}

	// ── LLM 流式输出（指令式：无推断状态）──

	thinkingChunk(token: string): void {
		write(style.gray(token));
	}

	thinkingEnd(): void {
		writeln();
	}

	contentChunk(token: string): void {
		write(token);
	}

	contentEnd(): void {
		writeln();
	}

	toolCallArgStart(index: number, name: string): void {
		this.hadStreamingArgs = true;
		this.streamingToolCalls.set(index, { name, args: "" });
	}

	toolCallArgChunk(index: number, chunk: string): void {
		const entry = this.streamingToolCalls.get(index);
		if (!entry) return;
		entry.args += chunk;

		// 非 TTY：只静默累积（等 toolCallArgEnd 或 streamEnd 输出最终形式）
		if (!isTTY) return;

		// TTY：重绘整个流式区域（LiveRegion clear+rewrite 实现原地刷新）
		this.streamRegion.clear();
		this.redrawStreamingRegion();
	}

	toolCallArgEnd(index: number, tc: ToolCallRecord): void {
		// 从 streaming 区域毕业 → 输出最终结构化渲染
		this.streamingToolCalls.delete(index);

		if (isTTY) {
			this.streamRegion.clear();
		}
		// 渲染该工具的最终形式
		for (const line of renderToolArgs(tc.tool, tc.args)) {
			writeln(line);
		}
		// 重绘剩余 streaming 的工具
		if (isTTY && this.streamingToolCalls.size > 0) {
			this.streamRegion.reset();
			this.redrawStreamingRegion();
		} else {
			this.streamRegion.reset();
		}
	}

	streamEnd(): void {
		// 安全网：处理因截断而未触发 argEnd 的残留工具
		if (this.streamingToolCalls.size > 0) {
			if (isTTY) {
				this.streamRegion.clear();
			}
			for (const [, tc] of [...this.streamingToolCalls.entries()].sort(
				(a, b) => a[0] - b[0],
			)) {
				const parsed = tryParseArgs(tc.args);
				if (parsed) {
					for (const line of renderToolArgs(tc.name, parsed)) {
						writeln(line);
					}
				} else {
					writeln(
						`${style.dim("▸")} ${style.cyan(tc.name)} ${style.gray(tc.args.slice(0, 80))}`,
					);
				}
			}
			this.streamingToolCalls.clear();
		}
		this.streamRegion.reset();
	}

	// ── 工具执行（语义清晰：不与参数流混淆）──

	toolExecStart(tc: ToolCallRecord): void {
		this.toolRegion.reset();
		// 流式模式下参数已由 toolCallArgEnd/streamEnd 渲染，不重复
		if (this.hadStreamingArgs) return;
		// 非流式回退：渲染结构化参数
		for (const line of renderToolArgs(tc.tool, tc.args)) {
			this.toolRegion.writeln(line);
		}
	}

	toolExecChunk(_tool: string, chunk: string): void {
		for (const line of chunk.split("\n")) {
			if (line) {
				this.toolRegion.writeln(`  ${style.dim("│")} ${style.dim(line)}`);
			}
		}
	}

	toolExecEnd(result: ToolResult): void {
		const summary = this.formatToolResult(result);
		writeln(summary);
	}

	// ── 特殊事件 ──

	textResponse(content: string, idleCount: number): void {
		if (content) {
			writeln(content);
		}
		writeln(
			style.gray(
				`(text response, ${content.length} chars ~${estimateTokens(content)} tok, idle=${idleCount})`,
			),
		);
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
		this.hadStreamingArgs = false;
		this.streamingToolCalls.clear();
		this.streamRegion.reset();
		this.toolRegion.reset();
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
				switch (result.status) {
					case "timed_out":
						return `${style.dim("◂")} ${style.cyan("exec")} ${duration} ${style.yellow(`timeout → bg PID=${result.pid}`)}`;
					case "truncated": {
						const exit =
							result.exitCode === 0
								? style.green(`exit=${result.exitCode}`)
								: style.red(`exit=${result.exitCode}`);
						return `${style.dim("◂")} ${style.cyan("exec")} ${duration} ${exit} ${style.yellow(`truncated → ${result.outputFile}`)}`;
					}
					case "completed": {
						const exit =
							result.exitCode === 0
								? style.green(`exit=${result.exitCode}`)
								: style.red(`exit=${result.exitCode}`);
						const outLen = result.stdout.length + result.stderr.length;
						const estTk = estimateTokens(result.stdout + result.stderr);
						return `${style.dim("◂")} ${style.cyan("exec")} ${duration} ${exit} ${style.gray(`${outLen} chars`)} ${style.dim(`~${estTk} tok`)}`;
					}
				}
				break;
			}
			case "write": {
				if (result.status === "failed" || result.status === "recover_failed") {
					return `${style.dim("◂")} ${style.cyan("write")} ${result.call.args.path}: ${style.red(result.error ?? "failed")}`;
				}
				return `${style.dim("◂")} ${style.cyan("write")} ${result.call.args.path}`;
			}
			case "edit": {
				const path = result.call.args.path;
				const duration = style.gray(
					`${(result.durationMs / 1000).toFixed(1)}s`,
				);
				const rounds = style.gray(`${result.rounds}r`);
				if (!result.success) {
					return `${style.dim("◂")} ${style.cyan("edit")} ${path} ${duration} ${rounds} ${style.red(result.error ?? "failed")}`;
				}
				const { added, removed } = result.diff;
				const lineStats =
					[
						added > 0 ? style.green(`+${added}`) : null,
						removed > 0 ? style.red(`-${removed}`) : null,
					]
						.filter(Boolean)
						.join(" ") || style.gray("(no changes)");
				return `${style.dim("◂")} ${style.cyan("edit")} ${path} ${duration} ${rounds} ${lineStats} ${style.green("✓")}`;
			}
			case "padding": {
				return `${style.dim("◂")} ${style.cyan("padding")}`;
			}
			case "reminder": {
				const chars = result.call.args.content.length;
				const estTk = estimateTokens(result.call.args.content);
				return `${style.dim("◂")} ${style.cyan("reminder")} ${style.gray(`(est. ${result.call.args.estimate} rounds)`)} ${style.gray(`${chars} chars`)} ${style.dim(`~${estTk} tok`)}`;
			}
			case "submit": {
				return `${style.dim("◂")} ${style.cyan("submit")}`;
			}
			default: {
				return `${style.dim("◂")} ${style.cyan(result.tool)}`;
			}
		}
	}

	/** 将当前所有 streaming 工具调用重绘到 streamRegion */
	private redrawStreamingRegion(): void {
		for (const [, tc] of [...this.streamingToolCalls.entries()].sort(
			(a, b) => a[0] - b[0],
		)) {
			const parsed = tryParseArgs(tc.args);
			if (parsed && Object.keys(parsed).length > 0) {
				for (const line of renderToolArgsStreaming(tc.name, parsed)) {
					this.streamRegion.writeln(line);
				}
			} else {
				this.streamRegion.writeln(
					`${style.dim("▸")} ${style.cyan(tc.name)} ${style.gray("(streaming…)")}`,
				);
			}
		}
	}
}
