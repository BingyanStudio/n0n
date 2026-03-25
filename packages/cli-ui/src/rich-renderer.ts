/**
 * RichRenderer — 富终端 UI 渲染器
 *
 * 彩色角色标签、流式 thinking/content、结构化工具参数显示、
 * 流式工具输出（exec stdout/stderr 实时）、LiveRegion 行替换。
 */

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

	// 总 token
	parts.push(`${fmtTokens(usage.totalTokens)} tok`);

	// cache 状态 — 只在有缓存活动时显示
	if (usage.cacheReadTokens > 0 || usage.cacheWriteTokens > 0) {
		const cacheParts: string[] = [];
		if (usage.cacheReadTokens > 0) {
			// 计算 cache hit 占总输入的百分比
			// 总输入 = inputTokens(新计算) + cacheReadTokens(缓存命中) + cacheWriteTokens(缓存写入)
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
		// 无缓存活动 — 提示可能需要关注
		parts.push(style.dim("no cache"));
	}

	return parts.join(" · ");
}

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

	roundStart(
		round: number,
		maxRounds: number,
		msgCount: number,
		lastUsage?: RoundTokenUsage | null,
	): void {
		writeln();
		write(label.agent());

		const roundInfo = `round ${round}/${maxRounds} (${msgCount} msgs)`;
		if (lastUsage) {
			writeln(
				style.gray(`  ${roundInfo} · ${formatUsageSummary(lastUsage)}`),
			);
		} else {
			writeln(style.gray(`  ${roundInfo}`));
		}
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
			// TTY：streamRegion 已有实时渲染的内容，clear 后重写最终版本
			// 非 TTY：streamRegion 未输出任何内容，直接写最终版本即可
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
			this.skipToolCallStarts = this.streamingToolCalls.size;
			this.streamingToolCalls.clear();
			// 重置 streamRegion 行计数，防止后续 clear() 误删已提交行
			this.streamRegion.reset();
		}
	}

	textResponse(content: string, idleCount: number): void {
		if (content) {
			writeln(content);
		}
		writeln(
			style.gray(
				`(text response, ${content.length} chars, idle=${idleCount})`,
			),
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

		// edit: 显示 path 和截断的 intent
		if (tc.tool === "edit") {
			const path = tc.args.path ?? "?";
			const intent = typeof tc.args.intent === "string" ? tc.args.intent : "";
			const truncatedIntent =
				intent.length > 60 ? `${intent.slice(0, 60)}...` : intent;
			this.toolRegion.writeln(
				`${style.dim("▸")} ${style.cyan("edit")} ${style.gray(path)}`,
			);
			this.toolRegion.writeln(`  ${style.dim("│")} ${truncatedIntent}`);
			this.toolRegion.writeln(
				`  ${style.dim("├")}${style.dim("─".repeat(30))}`,
			);
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

		// 非 TTY：只静默累积，不输出（等 contentEnd 一次性渲染最终结果）
		if (!isTTY) return;

		// TTY：重绘整个流式区域（LiveRegion clear+rewrite 实现原地刷新）
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
			case "reminder": {
				return `${style.dim("◂")} ${style.cyan("reminder")} ${style.gray(`(in ${result.call.args.delay} rounds)`)} ${style.gray(`${result.call.args.content.length} chars`)}`;
			}
			case "submit": {
				return `${style.dim("◂")} ${style.cyan("submit")}`;
			}
		}
	}
}
