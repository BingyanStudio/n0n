/**
 * FeishuRenderer — 飞书流式渲染器
 *
 * 将 agentLoop 事件映射为按轮次分块的过程卡片。
 * 每个 round 内部按因果顺序排列：
 *   thinking → content → tool calls → tool results
 *
 * 流式 token 通过节流刷新到 activity 区域，
 * 完成后归档为轮次内的日志行。
 */

import type { Renderer, ToolCallRecord, ToolResult } from "@n0n/types";
import type { FeishuConversation } from "./conversation.ts";

const THROTTLE_MS = 1500;
const SHORT = 160;
const LONG = 600;

// ── 工具函数 ──

function compact(text: string, limit = SHORT): string {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s) return "(empty)";
	return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

function json(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function fmtArgs(args: Record<string, unknown>): string {
	return Object.entries(args)
		.map(([k, v]) => {
			const val = typeof v === "string" ? v : json(v);
			return `${k}=${compact(val, 60)}`;
		})
		.join(", ");
}

function fmtResult(r: ToolResult): string {
	switch (r.tool) {
		case "exec":
			return `exit=${r.exitCode}  ${(r.durationMs / 1000).toFixed(1)}s`;
		case "write":
			return r.success
				? `${r.path} (${r.replacedCount}× replaced)`
				: `${r.path}: ${r.error ?? "failed"}`;
		case "reminder":
			return `delay=${r.delay}`;
		case "submit":
			return compact(json(r.result), 120);
	}
}

// ── 渲染器 ──

export class FeishuRenderer implements Renderer {
	private thinkBuf = "";
	private contentBuf = "";
	private toolOutBuf = "";
	private curTool = "";
	private lastFlush = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly conv: FeishuConversation) {}

	async drain(): Promise<void> {
		this.stopTimer();
		this.flushBuffers();
		await this.conv.drain();
	}

	userMessage(_content: string): void {
		// 用户消息不单独显示，已在 round title 中体现
	}

	roundStart(round: number, maxRounds: number, msgCount: number): void {
		this.conv.setTitle(`n0n · round ${round}/${maxRounds}`);
		this.conv.startRound(`Round ${round}  ·  ${msgCount} msgs`);
	}

	thinkingToken(token: string): void {
		this.thinkBuf += token;
		this.scheduleFlush();
	}

	contentToken(token: string): void {
		// thinking → content: 归档 thinking
		if (this.thinkBuf) {
			this.conv.appendLine({
				prefix: "│",
				text: `thinking: ${compact(this.thinkBuf, LONG)}`,
			});
			this.thinkBuf = "";
		}
		this.contentBuf += token;
		this.scheduleFlush();
	}

	contentEnd(): void {
		this.stopTimer();
		if (this.thinkBuf) {
			this.conv.appendLine({
				prefix: "│",
				text: `thinking: ${compact(this.thinkBuf, LONG)}`,
			});
			this.thinkBuf = "";
		}
		if (this.contentBuf.trim()) {
			this.conv.appendLine({
				prefix: "·",
				text: compact(this.contentBuf, LONG),
			});
			this.contentBuf = "";
		}
		this.conv.setActivity("");
	}

	textResponse(content: string, idleCount: number): void {
		if (content) {
			this.conv.appendLine({
				prefix: "·",
				text: compact(content),
			});
		}
		if (idleCount > 0) {
			this.conv.appendLine({ prefix: "│", text: `idle=${idleCount}` });
		}
	}

	toolCallStart(tc: ToolCallRecord): void {
		this.curTool = tc.tool;
		this.toolOutBuf = "";
		this.conv.appendLine({
			prefix: "▸",
			text: `**${tc.tool}**  ${fmtArgs(tc.args)}`,
		});
	}

	toolCallArgChunk(): void {}

	toolResultChunk(_tool: string, chunk: string): void {
		this.toolOutBuf += chunk;
		this.scheduleFlush();
	}

	toolCallEnd(result: ToolResult): void {
		this.stopTimer();
		const summary = fmtResult(result);
		const isErr = result.tool === "exec" && result.exitCode !== 0;
		this.conv.appendLine({
			prefix: isErr ? "✗" : "◂",
			text: `**${result.tool}** → ${summary}`,
		});
		this.conv.setActivity("");
		this.toolOutBuf = "";
		this.curTool = "";
	}

	submitAccepted(): void {
		this.conv.appendLine({ prefix: "✔", text: "submit accepted" });
	}

	submitRejected(attempt: number, maxAttempts: number, error: string): void {
		this.conv.appendLine({
			prefix: "✗",
			text: `submit rejected (${attempt}/${maxAttempts}): ${compact(error)}`,
		});
	}

	agentTerminated(reason: string): void {
		this.conv.appendLine({ prefix: "✗", text: compact(reason) });
	}

	// ── 节流 ──

	private scheduleFlush(): void {
		if (this.timer) return;
		const elapsed = Date.now() - this.lastFlush;
		const delay = Math.max(0, THROTTLE_MS - elapsed);
		this.timer = setTimeout(() => {
			this.timer = null;
			this.flushBuffers();
		}, delay);
	}

	private stopTimer(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private flushBuffers(): void {
		this.lastFlush = Date.now();
		if (this.thinkBuf) {
			this.conv.setActivity(`│ thinking…\n│ ${compact(this.thinkBuf, 200)}`);
		} else if (this.contentBuf) {
			this.conv.setActivity(compact(this.contentBuf, 200));
		} else if (this.toolOutBuf) {
			this.conv.setActivity(
				`│ ${this.curTool}…\n│ ${compact(this.toolOutBuf, 200)}`,
			);
		}
	}
}
