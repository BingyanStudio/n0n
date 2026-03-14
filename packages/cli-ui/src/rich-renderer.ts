/**
 * RichRenderer — 富终端 UI 渲染器
 *
 * 彩色角色标签、流式 thinking/content、结构化工具参数显示、
 * 流式工具输出（exec stdout/stderr 实时）、LiveRegion 行替换。
 *
 * 改进（基于 tui-renderer-decision.md 替代方案）：
 * 1. LiveRegion 基于终端宽度计算实际显示行数（含自动折行）
 * 2. 每个工具调用使用独立的 LiveRegion，避免多工具输出混乱
 * 3. 支持输入锁定：用户输入时暂停渲染输出
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

	/**
	 * 每个工具调用独立的 LiveRegion（toolCallId → region）
	 * 解决多工具共用一个 toolRegion 导致输出混乱的问题
	 */
	private toolRegions = new Map<string, LiveRegion>();
	/** 当前活跃的工具调用 ID（用于 toolResultChunk 路由） */
	private activeToolId: string | null = null;

	/** 所有受管理的 LiveRegion（用于统一 pause/resume） */
	private get allRegions(): LiveRegion[] {
		return [this.streamRegion, ...this.toolRegions.values()];
	}

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
		// 为每个工具调用创建独立的 LiveRegion
		const toolId = tc.id ?? `tool-${Date.now()}`;
		const region = new LiveRegion();
		this.toolRegions.set(toolId, region);
		this.activeToolId = toolId;

		// 如果 streamRegion 已经渲染了结构化参数，不重复渲染
		// toolCallStart 只在 streamRegion 为空时（非流式回退）渲染
		if (this.skipToolCallStarts > 0) {
			this.skipToolCallStarts--;
			return;
		}

		// 非流式回退：直接渲染结构化参数
		for (const line of renderToolArgs(tc.tool, tc.args)) {
			region.writeln(line);
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
		// 路由到当前活跃工具的独立 LiveRegion
		const region = this.activeToolId
			? this.toolRegions.get(this.activeToolId)
			: null;
		if (!region) return;

		// 逐 chunk 追加到对应工具的 region
		for (const line of chunk.split("\n")) {
			if (line) {
				region.writeln(`  ${style.dim("│")} ${style.dim(line)}`);
			}
		}
	}

	toolCallEnd(result: ToolResult): void {
		const summary = this.formatToolResult(result);

		// 清理当前工具的 LiveRegion（输出已完成，不再需要替换）
		if (this.activeToolId) {
			const region = this.toolRegions.get(this.activeToolId);
			region?.reset();
			this.toolRegions.delete(this.activeToolId);
			this.activeToolId = null;
		}

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
		// 清理所有工具 region
		for (const region of this.toolRegions.values()) {
			region.reset();
		}
		this.toolRegions.clear();
		this.activeToolId = null;
		this.skipToolCallStarts = 0;
		writeln();
		writeln(`${style.yellow("⚡")} ${style.gray("已中断输出")}`);
	}

	// ── 输入锁定：用户输入时暂停渲染输出 ──

	/**
	 * 暂停所有 LiveRegion 输出。
	 * 在用户输入时调用，防止 readline 和渲染器同时写 stderr 导致冲突。
	 */
	pauseOutput(): void {
		for (const region of this.allRegions) {
			region.pause();
		}
	}

	/**
	 * 恢复所有 LiveRegion 输出，刷出暂停期间缓冲的内容。
	 * 在用户输入完成后调用。
	 */
	resumeOutput(): void {
		for (const region of this.allRegions) {
			region.resume();
		}
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
				const diff = `+${result.linesAdded} -${result.linesRemoved}`;
				return `${style.dim("◂")} ${style.cyan("edit")} ${result.call.args.path} ${style.gray(`(${diff} lines)`)}`;
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
