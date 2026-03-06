/**
 * FeishuRenderer — 飞书流式渲染器
 *
 * 将 agentLoop 事件映射为过程卡片的日志条目。
 * 设计风格参考 CLI RichRenderer：
 * - round → 粗体标题行
 * - thinking → 折叠面板（不占主视图空间）
 * - tool call → ▸ 开始 / ◂ 结束（紧凑摘要）
 * - 流式 token → 节流刷新到 activity 区域
 */

import type { Renderer, ToolCallRecord, ToolResult } from "@n0n/types";
import type { FeishuConversation } from "./conversation.ts";

const THROTTLE_MS = 1500;
const INLINE_LEN = 160;
const DETAIL_LEN = 800;

// ── 工具函数 ──

function compact(text: string, limit = INLINE_LEN): string {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s) return "(empty)";
	return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

function stringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function fmtToolResult(r: ToolResult): string {
	switch (r.tool) {
		case "exec":
			return `exit=${r.exitCode} ${(r.durationMs / 1000).toFixed(1)}s`;
		case "write":
			return r.success
				? `${r.path} (${r.replacedCount}× replaced)`
				: `${r.path}: ${r.error ?? "failed"}`;
		case "reminder":
			return `delay=${r.delay}`;
		case "submit":
			return compact(stringify(r.result), 120);
	}
}

/** 格式化工具参数为可读的 key=value 形式 */
function fmtToolArgs(args: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [k, v] of Object.entries(args)) {
		const val = typeof v === "string" ? v : stringify(v);
		parts.push(`${k}=${compact(val, 60)}`);
	}
	return parts.join(", ");
}

/** 格式化工具参数为详情面板内容（树形结构） */
function fmtToolArgsDetail(
	tool: string,
	args: Record<string, unknown>,
): string {
	const lines: string[] = [`**${tool}**`];
	for (const [k, v] of Object.entries(args)) {
		const val = typeof v === "string" ? v : stringify(v);
		lines.push(`├ **${k}**`);
		// 多行值缩进显示
		const valLines = val.split("\n");
		const maxLines = 8;
		for (const vl of valLines.slice(0, maxLines)) {
			lines.push(`│ ${vl}`);
		}
		if (valLines.length > maxLines) {
			lines.push(`│ … (${valLines.length - maxLines} more lines)`);
		}
	}
	return lines.join("\n");
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

	userMessage(content: string): void {
		this.conv.appendLog({ kind: "info", text: compact(content) });
	}

	roundStart(round: number, maxRounds: number, msgCount: number): void {
		this.conv.setTitle(`n0n · round ${round}/${maxRounds}`);
		this.conv.appendLog({
			kind: "round",
			text: `round ${round}/${maxRounds}  (${msgCount} msgs)`,
		});
	}

	thinkingToken(token: string): void {
		this.thinkBuf += token;
		this.scheduleFlush();
	}

	contentToken(token: string): void {
		// thinking → content 切换：把 thinking 存为折叠详情
		if (this.thinkBuf) {
			this.conv.appendLog({
				kind: "thinking",
				text: "thinking",
				detail: compact(this.thinkBuf, DETAIL_LEN),
			});
			this.thinkBuf = "";
		}
		this.contentBuf += token;
		this.scheduleFlush();
	}

	contentEnd(): void {
		this.stopTimer();
		// 残余 thinking
		if (this.thinkBuf) {
			this.conv.appendLog({
				kind: "thinking",
				text: "thinking",
				detail: compact(this.thinkBuf, DETAIL_LEN),
			});
			this.thinkBuf = "";
		}
		// 残余 content
		if (this.contentBuf.trim()) {
			this.conv.appendLog({
				kind: "content",
				text: compact(this.contentBuf),
			});
			this.contentBuf = "";
		}
		this.conv.setActivity("");
	}

	textResponse(content: string, idleCount: number): void {
		if (content) {
			this.conv.appendLog({
				kind: "content",
				text: compact(content),
				detail: content.length > INLINE_LEN ? content : undefined,
			});
		}
		if (idleCount > 0) {
			this.conv.appendLog({ kind: "info", text: `idle=${idleCount}` });
		}
	}

	toolCallStart(tc: ToolCallRecord): void {
		this.curTool = tc.tool;
		this.toolOutBuf = "";
		this.conv.appendLog({
			kind: "tool_start",
			text: `**${tc.tool}** ${fmtToolArgs(tc.args)}`,
			detail: fmtToolArgsDetail(tc.tool, tc.args),
		});
	}

	toolCallArgChunk(): void {
		// 飞书卡片无法逐字符流式，忽略
	}

	toolResultChunk(_tool: string, chunk: string): void {
		this.toolOutBuf += chunk;
		this.scheduleFlush();
	}

	toolCallEnd(result: ToolResult): void {
		this.stopTimer();
		const summary = fmtToolResult(result);
		const isErr = result.tool === "exec" && result.exitCode !== 0;
		const output = this.toolOutBuf.trim();

		let detail: string | undefined;
		if (output) {
			detail = `**${result.tool}** → ${summary}\n\`\`\`\n${compact(output, DETAIL_LEN)}\n\`\`\``;
		}

		this.conv.appendLog({
			kind: isErr ? "tool_error" : "tool_end",
			text: `**${result.tool}** → ${summary}`,
			detail,
		});
		this.conv.setActivity("");
		this.toolOutBuf = "";
		this.curTool = "";
	}

	submitAccepted(): void {
		this.conv.appendLog({ kind: "result_ok", text: "submit accepted" });
	}

	submitRejected(attempt: number, maxAttempts: number, error: string): void {
		this.conv.appendLog({
			kind: "result_err",
			text: `submit rejected (${attempt}/${maxAttempts})`,
			detail: error,
		});
	}

	agentTerminated(reason: string): void {
		this.conv.appendLog({
			kind: "result_err",
			text: compact(reason),
		});
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
				`│ ${this.curTool} 执行中…\n│ ${compact(this.toolOutBuf, 200)}`,
			);
		}
	}
}
