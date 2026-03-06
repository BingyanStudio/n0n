/**
 * FeishuRenderer — 飞书流式渲染器
 *
 * 实现 Renderer 接口，将 agentLoop 事件映射为飞书步骤流卡片更新。
 * 模仿 CLI RichRenderer 的逐步显示效果：
 * - 每个 round 显示为一个步骤
 * - 工具调用显示为子步骤（带输入/输出摘要）
 * - thinking/content 实时刷新到「当前活动」区域
 * - 节流控制避免飞书 API 限流
 */

import type { Renderer, ToolCallRecord, ToolResult } from "@n0n/types";
import type { FeishuConversation } from "./conversation.ts";

/** 刷新节流间隔（ms），避免飞书 API 限流 */
const THROTTLE_MS = 1500;

/** 内联文本截断长度 */
const INLINE_LIMIT = 200;

// ── 工具函数 ──

function compact(text: string, limit = INLINE_LIMIT): string {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s) return "(empty)";
	return s.length > limit ? `${s.slice(0, limit)}...` : s;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function toolResultSummary(result: ToolResult): string {
	switch (result.tool) {
		case "exec":
			return `exit=${result.exitCode}, ${(result.durationMs / 1000).toFixed(1)}s`;
		case "write":
			return result.success
				? `${result.path} (replaced ${result.replacedCount}×)`
				: `${result.path}: ${result.error ?? "failed"}`;
		case "reminder":
			return `delay=${result.delay}`;
		case "submit":
			return `result=${compact(safeStringify(result.result), 120)}`;
	}
}

// ── 渲染器 ──

export class FeishuRenderer implements Renderer {
	private thinkingBuf = "";
	private contentBuf = "";
	private lastFlush = 0;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private currentToolName = "";
	private toolOutputBuf = "";

	constructor(private readonly conv: FeishuConversation) {}

	async drain(): Promise<void> {
		this.cancelFlushTimer();
		this.flushBuffers();
		await this.conv.drain();
	}

	userMessage(content: string): void {
		this.conv.addStep({
			icon: "📝",
			title: `用户: ${compact(content)}`,
		});
	}

	roundStart(round: number, maxRounds: number, msgCount: number): void {
		this.conv.setTitle(`🤖 Round ${round}/${maxRounds} (${msgCount} msgs)`);
		this.conv.addStep({
			icon: "⏳",
			title: `Round ${round} — 思考中...`,
		});
	}

	thinkingToken(token: string): void {
		this.thinkingBuf += token;
		this.scheduleFlush();
	}

	contentToken(token: string): void {
		// thinking → content 切换
		if (this.thinkingBuf) {
			this.conv.updateLastStep({
				detail: this.thinkingBuf,
			});
			this.thinkingBuf = "";
		}
		this.contentBuf += token;
		this.scheduleFlush();
	}

	contentEnd(): void {
		this.cancelFlushTimer();
		this.flushBuffers();
		this.conv.updateLastStep({
			icon: "✅",
			title: "思考完成",
		});
	}

	textResponse(content: string, idleCount: number): void {
		if (content) {
			this.conv.addStep({
				icon: "💭",
				title: `回复: ${compact(content)}`,
				detail: content,
			});
		}
		if (idleCount > 0) {
			this.conv.setActivity(`idle=${idleCount}`);
		}
	}

	toolCallStart(tc: ToolCallRecord): void {
		this.currentToolName = tc.tool;
		this.toolOutputBuf = "";
		const argsText = compact(safeStringify(tc.args), 150);
		this.conv.addStep({
			icon: "🔧",
			title: `${tc.tool}: ${argsText}`,
		});
	}

	toolCallArgChunk(
		_index: number,
		_name: string | undefined,
		_chunk: string,
	): void {
		// 飞书卡片不支持逐字符流式，忽略参数 chunk
	}

	toolResultChunk(_tool: string, chunk: string): void {
		this.toolOutputBuf += chunk;
		this.scheduleFlush();
	}

	toolCallEnd(result: ToolResult): void {
		this.cancelFlushTimer();
		const summary = toolResultSummary(result);
		const isError = result.tool === "exec" && result.exitCode !== 0;
		const detail = this.toolOutputBuf.trim()
			? `**结果:** ${summary}\n\n\`\`\`\n${compact(this.toolOutputBuf, 600)}\n\`\`\``
			: `**结果:** ${summary}`;

		this.conv.updateLastStep({
			icon: isError ? "❌" : "✅",
			title: `${result.tool}: ${summary}`,
			detail,
		});
		this.conv.setActivity("");
		this.toolOutputBuf = "";
		this.currentToolName = "";
	}

	submitAccepted(): void {
		this.conv.addStep({ icon: "✅", title: "Submit 已接受" });
	}

	submitRejected(attempt: number, maxAttempts: number, error: string): void {
		this.conv.addStep({
			icon: "❌",
			title: `Submit 被拒绝 (${attempt}/${maxAttempts})`,
			detail: error,
		});
	}

	agentTerminated(reason: string): void {
		this.conv.addStep({
			icon: "❌",
			title: `Agent 终止: ${compact(reason)}`,
		});
	}

	// ── 节流刷新 ──

	private scheduleFlush(): void {
		if (this.flushTimer) return;
		const elapsed = Date.now() - this.lastFlush;
		const delay = Math.max(0, THROTTLE_MS - elapsed);
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			this.flushBuffers();
		}, delay);
	}

	private cancelFlushTimer(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
	}

	private flushBuffers(): void {
		this.lastFlush = Date.now();
		if (this.thinkingBuf) {
			this.conv.setActivity(`💭 思考中...\n${compact(this.thinkingBuf, 300)}`);
		} else if (this.contentBuf) {
			this.conv.setActivity(`📝 输出中...\n${compact(this.contentBuf, 300)}`);
		} else if (this.toolOutputBuf) {
			this.conv.setActivity(
				`🔧 ${this.currentToolName} 执行中...\n${compact(this.toolOutputBuf, 300)}`,
			);
		}
	}
}
