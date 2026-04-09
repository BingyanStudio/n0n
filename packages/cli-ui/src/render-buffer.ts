/**
 * RenderBuffer — CLI 专用 FIFO 有序输出缓冲（同步推模型）
 *
 * 终端是线性的：一次只能输出一个工具的内容。但 scheduler 并行执行工具，
 * 事件无序到达。RenderBuffer 按入队顺序逐个 flush 到 sink：
 * 只有队首工具的事件实时输出，非队首工具的事件暂存 buffer。
 *
 * 支持 pause/resume：pause 状态下所有事件暂存，resume 时一次性 flush。
 * 用于 LLM 流式阶段暂缓工具执行渲染，流式结束后再开始输出。
 */

import type { ToolCallRecord, ToolResult } from "@n0n/types";

// ── 渲染回调接口 ──

export interface RenderSink {
	onStart(tc: ToolCallRecord): void;
	onChunk(tool: string, chunk: string): void;
	onEnd(result: ToolResult): void;
}

// ── 内部缓冲事件 ──

type BufferedEvent =
	| { kind: "chunk"; tool: string; chunk: string }
	| { kind: "end"; result: ToolResult };

interface ToolEntry {
	tc: ToolCallRecord;
	events: BufferedEvent[];
	done: boolean;
	/** 是否已向 sink 发射过 onStart */
	started: boolean;
}

// ── RenderBuffer ──

export class RenderBuffer {
	private readonly queue: ToolEntry[] = [];
	private readonly entryMap = new Map<string, ToolEntry>();
	private headIdx = 0;
	private paused = true;

	constructor(private readonly sink: RenderSink) {}

	/** 注册一个新工具（按调用顺序） */
	register(tc: ToolCallRecord): void {
		const entry: ToolEntry = { tc, events: [], done: false, started: false };
		this.queue.push(entry);
		this.entryMap.set(tc.id, entry);

		if (!this.paused && this.isHead(entry)) {
			entry.started = true;
			this.sink.onStart(entry.tc);
		}
	}

	/** 推入一个 chunk 事件 */
	pushChunk(tcId: string, tool: string, chunk: string): void {
		const entry = this.entryMap.get(tcId);
		if (!entry) return;

		if (!this.paused && this.isHead(entry)) {
			if (!entry.started) {
				entry.started = true;
				this.sink.onStart(entry.tc);
			}
			this.sink.onChunk(tool, chunk);
		} else {
			entry.events.push({ kind: "chunk", tool, chunk });
		}
	}

	/** 推入完成事件（result 为 null 表示 argError，仅推进队列不渲染） */
	pushEnd(tcId: string, result: ToolResult | null): void {
		const entry = this.entryMap.get(tcId);
		if (!entry) return;
		entry.done = true;

		if (result) {
			if (!this.paused && this.isHead(entry)) {
				if (!entry.started) {
					entry.started = true;
					this.sink.onStart(entry.tc);
				}
				this.sink.onEnd(result);
				this.headIdx++;
				this.flushHead();
			} else {
				entry.events.push({ kind: "end", result });
			}
		} else {
			// argError: 无 result，推进队列但不渲染
			if (!this.paused && this.isHead(entry)) {
				this.headIdx++;
				this.flushHead();
			}
		}
	}

	/** 开始输出（flush 已缓冲的事件，后续事件实时输出） */
	resume(): void {
		this.paused = false;
		this.flushHead();
	}

	/** 重置所有状态（每轮开始时调用） */
	reset(): void {
		this.queue.length = 0;
		this.entryMap.clear();
		this.headIdx = 0;
		this.paused = true;
	}

	private isHead(entry: ToolEntry): boolean {
		return this.queue[this.headIdx] === entry;
	}

	/** 从当前队首开始，flush 所有可输出的事件 */
	private flushHead(): void {
		while (this.headIdx < this.queue.length) {
			const entry = this.queue[this.headIdx]!;

			// argError 的 entry：done 但无 events，跳过不渲染
			if (entry.done && entry.events.length === 0 && !entry.started) {
				this.headIdx++;
				continue;
			}

			if (!entry.started) {
				entry.started = true;
				this.sink.onStart(entry.tc);
			}

			for (const event of entry.events) {
				if (event.kind === "chunk") {
					this.sink.onChunk(event.tool, event.chunk);
				} else {
					this.sink.onEnd(event.result);
				}
			}
			entry.events.length = 0;

			if (entry.done) {
				this.headIdx++;
				continue;
			}
			// 当前 entry 还在执行中，后续 push 会实时输出
			break;
		}
	}
}
