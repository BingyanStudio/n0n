/**
 * RenderBuffer — FIFO 有序输出缓冲
 *
 * 输入端：并行执行系统按 tool call ID push 事件（无序）。
 * 输出端：按入队顺序逐个 flush 到 Renderer。只有队首工具的事件实时输出，
 * 非队首工具的事件暂存 buffer。队首完成时出队，下一个的 buffer 被 flush。
 */

import type {
	Renderer,
	ToolCallRecord,
	ToolResult,
} from "@n0n/types";

// ── 事件类型 ──

type RenderEvent =
	| { kind: "start"; tc: ToolCallRecord }
	| { kind: "chunk"; tool: string; chunk: string }
	| { kind: "end"; result: ToolResult | null };

/** 单个工具的事件缓冲 */
interface ToolBuffer {
	tc: ToolCallRecord;
	events: RenderEvent[];
	done: boolean;
}

// ── RenderBuffer ──

export class RenderBuffer {
	/** 按入队顺序排列的工具缓冲 */
	private readonly queue: ToolBuffer[] = [];
	/** ID → ToolBuffer 快速查找 */
	private readonly bufferMap = new Map<string, ToolBuffer>();
	/** 当前队首索引（已输出的工具不从数组中删除，用索引推进） */
	private headIdx = 0;
	/** 外部等待"有新的可输出事件"的 resolver */
	private wakeup: (() => void) | null = null;
	/** 是否已 seal（不再接收新工具） */
	private sealed = false;

	/** 注册一个新工具（按调用顺序） */
	register(tc: ToolCallRecord): void {
		const buf: ToolBuffer = {
			tc,
			events: [{ kind: "start", tc }],
			done: false,
		};
		this.queue.push(buf);
		this.bufferMap.set(tc.id, buf);
		this.wakeup?.();
	}

	/** 推入一个 chunk 事件 */
	pushChunk(tcId: string, tool: string, chunk: string): void {
		const buf = this.bufferMap.get(tcId);
		if (!buf) return;
		buf.events.push({ kind: "chunk", tool, chunk });
		if (this.queue[this.headIdx] === buf) {
			this.wakeup?.();
		}
	}

	/** 推入完成事件 */
	pushEnd(tcId: string, result: ToolResult | null): void {
		const buf = this.bufferMap.get(tcId);
		if (!buf) return;
		buf.events.push({ kind: "end", result });
		buf.done = true;
		this.wakeup?.();
	}

	/** 标记不再有新工具注册 */
	seal(): void {
		this.sealed = true;
		this.wakeup?.();
	}

	/**
	 * 消费循环：按入队顺序将事件流式输出到 Renderer。
	 */
	async drain(
		renderer: Renderer,
		onToolDone: (tc: ToolCallRecord, result: ToolResult | null) => void,
		signal?: AbortSignal,
	): Promise<void> {
		while (!signal?.aborted) {
			const buf = this.queue[this.headIdx];

			if (!buf) {
				if (this.sealed) break;
				await this.wait();
				continue;
			}

			while (buf.events.length > 0) {
				const event = buf.events.shift()!;
				switch (event.kind) {
					case "start":
						renderer.toolExecStart(event.tc);
						break;
					case "chunk":
						renderer.toolExecChunk(event.tool, event.chunk);
						break;
					case "end":
						if (event.result) {
							renderer.toolExecEnd(event.result);
						}
						onToolDone(buf.tc, event.result);
						this.headIdx++;
						break;
				}
			}

			if (this.queue[this.headIdx] === buf && !buf.done) {
				await this.wait();
				continue;
			}

			if (this.headIdx >= this.queue.length && this.sealed) {
				break;
			}
		}
	}

	private wait(): Promise<void> {
		return new Promise<void>((r) => {
			this.wakeup = () => { this.wakeup = null; r(); };
		});
	}
}
