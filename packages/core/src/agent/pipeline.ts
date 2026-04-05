/**
 * ExecutionScheduler — 流水线工具执行调度器
 *
 * 两个独立组件：
 *
 * 1. ExecutionScheduler — 调度 & 并行执行
 *    有序队列 + 队首条件等待，并行性自然涌现。
 *
 * 2. RenderBuffer — FIFO 有序输出缓冲
 *    接收并行执行产生的事件，按入队顺序流式输出给 Renderer。
 *    只有队首工具的事件会实时传递；非队首工具的事件缓冲等待。
 *    队首完成时出队，下一个工具的缓冲被 flush。
 * TODO 当前 ExecutionScheduler 通过 attachRenderBuffer 与 RenderBuffer 耦合，且执行逻辑（startJob）直接推送渲染事件。后续应考虑通过事件发射器或回调接口进一步解耦调度与渲染，使两者可独立测试和替换。
 */

import type {
	Renderer,
	ToolCallRecord,
	ToolResult,
	ToolStreamEvent,
} from "@n0n/types";

// ── RenderBuffer 事件类型 ──

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

/**
 * FIFO 有序输出缓冲。
 *
 * 输入端：并行执行系统按 tool call ID push 事件（无序）。
 * 输出端：按入队顺序逐个 flush 到 Renderer。只有队首工具的事件实时输出，
 * 非队首工具的事件暂存 buffer。队首完成时出队，下一个的 buffer 被 flush。
 */
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
		// 只有队首工具的事件需要唤醒消费者
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
	 * 返回每个工具完成时的回调机会（通过 onToolDone）。
	 */
	async drain(
		renderer: Renderer,
		onToolDone: (tc: ToolCallRecord, result: ToolResult | null) => void,
		signal?: AbortSignal,
	): Promise<void> {
		while (!signal?.aborted) {
			const buf = this.queue[this.headIdx];

			if (!buf) {
				// 队列为空，等待新工具或 seal
				if (this.sealed) break;
				await this.wait();
				continue;
			}

			// flush 队首 buffer 中的所有已有事件
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
						// 队首完成，推进到下一个
						this.headIdx++;
						break;
				}
			}

			// 队首尚未完成，等待更多事件
			if (this.queue[this.headIdx] === buf && !buf.done) {
				await this.wait();
				continue;
			}

			// 如果已推进到队列末尾且已 seal，退出
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

// ── PipelineJob ──

/** 单个工具执行的状态 */
export interface PipelineJob {
	tc: ToolCallRecord;
	/** 最终结果（ToolResult 或 null） */
	result: ToolResult | null;
	/** 参数校验错误（如果发生） */
	argError: { type: "tool_arg_error"; callId: string; tool: string; error: string; schema?: Record<string, unknown> } | null;
	/** 是否执行完成 */
	done: boolean;
}

// ── 工具执行函数类型 ──

export type ToolExecutor = (
	tc: ToolCallRecord,
) => AsyncGenerator<ToolStreamEvent>;

// ── ExecutionScheduler ──

export class ExecutionScheduler {
	/** 按入队顺序排列的所有 job */
	private readonly jobs: PipelineJob[] = [];
	/** 待执行队列（FIFO） */
	private readonly pending: PipelineJob[] = [];
	/** 正在执行的 job（id → job） */
	private readonly active = new Map<string, PipelineJob>();
	/** producer 是否已结束 */
	private sealed = false;
	/** 条件变化通知 */
	private notify: (() => void) | null = null;
	/** 关联的渲染缓冲（可选） */
	private renderBuffer: RenderBuffer | null = null;

	constructor(private readonly executor: ToolExecutor) {}

	/** 关联一个 RenderBuffer，执行事件会自动推入 */
	attachRenderBuffer(buf: RenderBuffer): void {
		this.renderBuffer = buf;
	}

	/** Producer 调用：将工具加入待执行队列 */
	enqueue(tc: ToolCallRecord): void {
		const job: PipelineJob = { tc, result: null, argError: null, done: false };
		this.jobs.push(job);
		this.pending.push(job);
		this.renderBuffer?.register(tc);
		this.notify?.();
	}

	/** Producer 调用：标记不再有新工具入队 */
	seal(): void {
		this.sealed = true;
		this.renderBuffer?.seal();
		this.notify?.();
	}

	/** 获取按入队顺序排列的所有 job */
	orderedJobs(): readonly PipelineJob[] {
		return this.jobs;
	}

	/**
	 * 调度循环 — 持续检查队首，满足条件就启动执行。
	 * 当 sealed=true 且所有 job 完成时退出。
	 */
	async run(signal?: AbortSignal): Promise<void> {
		while (!signal?.aborted) {
			const head = this.pending[0];
			if (head && this.canExecute(head)) {
				this.pending.shift();
				this.startJob(head);
				continue;
			}

			if (this.sealed && this.pending.length === 0 && this.active.size === 0) {
				break;
			}

			await new Promise<void>((r) => {
				this.notify = () => { this.notify = null; r(); };
			});
		}
	}

	// ── 条件检查 ──

	private canExecute(job: PipelineJob): boolean {
		const tc = job.tc;
		switch (tc.tool) {
			case "write":
			case "edit": {
				const path = tc.args.path;
				for (const active of this.active.values()) {
					if (active.tc.tool === "exec") return false;
					if (
						(active.tc.tool === "write" || active.tc.tool === "edit") &&
						active.tc.args.path === path
					) return false;
				}
				return true;
			}
			case "exec":
				return this.active.size === 0;
			case "reminder":
			case "submit":
				return true;
			default:
				return false;
		}
	}

	// ── 执行启动 ──

	private startJob(job: PipelineJob): void {
		this.active.set(job.tc.id, job);

		const run = async () => {
			try {
				for await (const event of this.executor(job.tc)) {
					if (event.type === "tool_output_chunk") {
						this.renderBuffer?.pushChunk(job.tc.id, event.tool, event.chunk);
					} else if (event.type === "tool_arg_error") {
						job.argError = event;
					} else {
						// ToolResult
						job.result = event;
					}
				}
			} catch (err) {
				if (!job.result && !job.argError) {
					job.argError = {
						type: "tool_arg_error",
						callId: job.tc.id,
						tool: job.tc.tool,
						error: `Internal execution error: ${err instanceof Error ? err.message : String(err)}`,
					};
				}
			} finally {
				job.done = true;
				this.active.delete(job.tc.id);
				this.renderBuffer?.pushEnd(job.tc.id, job.result);
				this.notify?.();
			}
		};

		run(); // 非阻塞启动
	}
}
