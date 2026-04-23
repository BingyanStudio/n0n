/**
 * FeishuRenderer — 飞书流式渲染器（指令式事件模型）
 *
 * 将 agentLoop 事件映射为按轮次分块的过程卡片。
 * 信息层级：
 * - meta（灰色小字）：round 标题、idle 计数
 * - thinking（折叠面板）：LLM 思考过程，次要信息
 * - tool（markdown）：▸ 开始 / ◂ 结束，结构化摘要
 * - content（markdown）：LLM 回复，主要信息
 * - ok/err（加粗）：最终结果
 */

import type {
	Renderer,
	ToolCallRecord,
	ToolExecOutcome,
	ToolResult,
} from "@n0n/types";
import type { FeishuConversation } from "./conversation.ts";

/** 流式文本更新节流间隔（CardKit 限制 10次/秒，留余量） */
const THROTTLE_MS = 300;
const SHORT = 160;
const LONG = 600;

function compact(text: string | undefined | null, limit = SHORT): string {
	if (text == null) return "(empty)";
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

/**
 * 提取工具调用的标题摘要和展开详情。
 * 接受 ToolCallRecord 判别联合，通过 tc.tool 窄化后类型安全地访问参数。
 */
function fmtToolCall(tc: ToolCallRecord): { summary: string; detail: string } {
	let summary: string;
	switch (tc.tool) {
		case "exec":
			summary = `▸ **exec**  \`${compact(tc.args.script, 80)}\``;
			break;
		case "write":
			summary = `▸ **write**  ${compact(tc.args.path, 80)}`;
			break;
		case "submit":
			summary = `▸ **submit**  ${compact(json(tc.args), 60)}`;
			break;
		case "reminder":
			summary = `▸ **reminder**  ${compact(tc.args.content, 60)}`;
			break;
		case "edit":
			summary = `▸ **edit**  ${compact(tc.args.path, 80)}  ${compact(tc.args.intent, 60)}`;
			break;
		default: {
			// tc 类型是 ToolCallRecord | PartialToolCallRecord 联合，TS 不支持 default 分支自动窄化
			const unknown = tc as ToolCallRecord;
			summary = `▸ **${unknown.tool}**`;
		}
	}

	const lines: string[] = [];
	for (const [key, value] of Object.entries(tc.args)) {
		const strVal = typeof value === "string" ? value : json(value);
		const valLines = strVal.split("\n");
		if (valLines.length <= 1) {
			lines.push(`**${key}**: ${compact(strVal, 200)}`);
		} else {
			lines.push(`**${key}**:`);
			for (const vl of valLines.slice(0, 15)) {
				lines.push(`  ${vl}`);
			}
			if (valLines.length > 15) {
				lines.push(`  ... (${valLines.length - 15} more lines)`);
			}
		}
	}

	return { summary, detail: lines.join("\n") };
}

function fmtResult(r: ToolResult): string {
	switch (r.tool) {
		case "exec":
			switch (r.status) {
				case "backgrounded":
					return `waitfor exceeded → bg PID=${r.pid}  ${(r.durationMs / 1000).toFixed(1)}s`;
				case "truncated":
					return `exit=${r.exitCode} truncated  ${(r.durationMs / 1000).toFixed(1)}s`;
				case "completed":
					return `exit=${r.exitCode}  ${(r.durationMs / 1000).toFixed(1)}s`;
				default: {
					const _exhaustive: never = r;
					return `unknown exec status`;
				}
			}
		case "write":
			if (r.status === "failed" || r.status === "recover_failed") {
				return `${r.call.args.path}: ${r.error ?? "failed"}`;
			}
			return r.call.args.path;
		case "edit": {
			const path = r.call.args.path;
			const duration = `${(r.durationMs / 1000).toFixed(1)}s`;
			const rounds = `${r.rounds}r`;
			if (!r.success) {
				return `${path} ${duration} ${rounds} ${r.error ?? "failed"}`;
			}
			const { added, removed } = r.diff;
			const parts: string[] = [];
			if (added > 0) parts.push(`+${added}`);
			if (removed > 0) parts.push(`-${removed}`);
			const lineStats = parts.length > 0 ? parts.join(" ") : "(no changes)";
			return `${path} ${duration} ${rounds} ${lineStats} ✓`;
		}
		case "reminder":
			return `est=${r.call.args.estimate ?? 0}`;
		case "submit":
			return compact(json(r.cleanedResult), 120);
	}
}

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

	userMessage(_content: string): void {}

	roundStart(
		round: number,
		maxRounds: number,
		msgCount: number,
		_lastUsage?: import("@n0n/types").RoundTokenUsage | null,
	): void {
		this.conv.setTitle(`n0n · round ${round}/${maxRounds}`);
		this.conv.startRound(`Round ${round}  ·  ${msgCount} msgs`);
	}

	roundEnd(): void {}

	// ── LLM 流式输出 ──

	thinkingStart(): void {}

	thinkingChunk(token: string): void {
		this.thinkBuf += token;
		this.scheduleFlush();
	}

	thinkingEnd(): void {
		if (this.thinkBuf) {
			this.conv.appendLine({
				kind: "thinking",
				text: "thinking",
				detail: compact(this.thinkBuf, LONG),
			});
			this.thinkBuf = "";
		}
	}

	contentStart(): void {}

	contentChunk(token: string): void {
		this.contentBuf += token;
		this.scheduleFlush();
	}

	contentEnd(): void {}

	toolCallArgStart(_index: number, _name: string): void {}
	toolCallArgChunk(_index: number, _chunk: string): void {}
	toolCallArgEnd(_index: number, _tc: ToolCallRecord): void {}

	streamEnd(): void {
		this.stopTimer();
		// thinkingEnd 已由上游在 streamEnd 前触发，但作为安全网再检查一次
		if (this.thinkBuf) {
			this.conv.appendLine({
				kind: "thinking",
				text: "thinking",
				detail: compact(this.thinkBuf, LONG),
			});
			this.thinkBuf = "";
		}
		if (this.contentBuf.trim()) {
			this.conv.appendLine({
				kind: "content",
				text: compact(this.contentBuf, LONG),
			});
			this.contentBuf = "";
		}
		this.conv.setActivity("");
	}

	// ── 工具执行 ──

	toolExecStart(_tcId: string, tc: ToolCallRecord): void {
		this.curTool = tc.tool;
		this.toolOutBuf = "";
		const { summary, detail } = fmtToolCall(tc);
		this.conv.appendLine({ kind: "tool", text: summary, detail });
	}

	toolExecChunk(_tcId: string, _tool: string, chunk: string): void {
		this.toolOutBuf += chunk;
		this.scheduleFlush();
	}

	toolExecEnd(_tcId: string, outcome: ToolExecOutcome): void {
		if (outcome.status === "arg_error") return;
		const result = outcome.result;
		this.stopTimer();
		const summary = fmtResult(result);
		const isErr =
			result.tool === "exec" &&
			(result.status !== "completed" || result.exitCode !== 0);
		this.conv.appendLine({
			kind: isErr ? "err" : "tool",
			text: `◂ **${result.tool}** → ${summary}`,
		});
		this.conv.setActivity("");
		this.toolOutBuf = "";
		this.curTool = "";
	}

	// ── 特殊事件 ──

	textResponse(content: string, idleCount: number): void {
		if (content) {
			this.conv.appendLine({ kind: "content", text: compact(content) });
		}
		if (idleCount > 0) {
			this.conv.appendLine({ kind: "meta", text: `idle=${idleCount}` });
		}
	}

	submitAccepted(): void {
		this.conv.appendLine({ kind: "ok", text: "submit accepted" });
	}

	submitRejected(attempt: number, maxAttempts: number, error: string): void {
		this.conv.appendLine({
			kind: "err",
			text: `submit rejected (${attempt}/${maxAttempts}): ${compact(error)}`,
		});
	}

	agentTerminated(reason: string): void {
		this.conv.appendLine({ kind: "err", text: compact(reason) });
	}

	aborted(): void {
		this.stopTimer();
		this.thinkBuf = "";
		this.contentBuf = "";
		this.toolOutBuf = "";
		this.curTool = "";
		this.conv.setActivity("");
		this.conv.appendLine({ kind: "meta", text: "⚡ 已中断输出" });
	}

	// ── 内部 ──

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
			this.conv.setActivity(
				`<font color='grey'>${compact(this.thinkBuf, 200)}</font>`,
			);
		} else if (this.contentBuf) {
			this.conv.setActivity(compact(this.contentBuf, 200));
		} else if (this.toolOutBuf) {
			this.conv.setActivity(
				`<font color='grey'>${this.curTool}…  ${compact(this.toolOutBuf, 200)}</font>`,
			);
		}
	}
}
