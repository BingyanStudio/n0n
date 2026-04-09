/**
 * ExecutionScheduler — 流水线工具执行调度器
 *
 * 有序队列 + 队首条件等待，并行性自然涌现。
 * 各工具通过 canStart 回调声明自己的并行条件，scheduler 不感知具体工具语义。
 *
 * TODO: 移除 attachRenderBuffer 耦合，改为通过事件回调接口（onChunk、onEnd）发射 raw 事件。
 * 排序职责下放给消费者，RenderBuffer 抽离为独立工具模块。
 */

import type { ToolCallRecord, ToolResult, ToolStreamEvent } from "@n0n/types";
import type { RenderBuffer } from "./render-buffer.ts";

// ── 并行判断回调 ──

/**
 * 工具并行条件判断函数。
 * scheduler 在决定是否启动队首工具时调用。
 *
 * @param self 待启动的工具调用
 * @param active 当前正在执行的所有工具调用
 * @returns true 表示可以立即启动，false 表示需要等待
 */
export type CanStartFn = (
	self: ToolCallRecord,
	active: readonly ToolCallRecord[],
) => boolean;

/** 默认策略：等所有 active 完成后才启动（最保守） */
const defaultCanStart: CanStartFn = (_self, active) => active.length === 0;

// ── PipelineJob ──

/** 单个工具执行的状态 */
export interface PipelineJob {
	tc: ToolCallRecord;
	canStart: CanStartFn;
	result: ToolResult | null;
	argError: {
		type: "tool_arg_error";
		callId: string;
		tool: string;
		error: string;
		schema?: Record<string, unknown>;
	} | null;
	done: boolean;
}

// ── 工具执行函数类型 ──

export type ToolExecutor = (
	tc: ToolCallRecord,
) => AsyncGenerator<ToolStreamEvent>;

// ── ExecutionScheduler ──

export class ExecutionScheduler {
	private readonly jobs: PipelineJob[] = [];
	private readonly pending: PipelineJob[] = [];
	private readonly active = new Map<string, PipelineJob>();
	private sealed = false;
	private notify: (() => void) | null = null;
	private renderBuffer: RenderBuffer | null = null;

	constructor(private readonly executor: ToolExecutor) {}

	attachRenderBuffer(buf: RenderBuffer): void {
		this.renderBuffer = buf;
	}

	enqueue(tc: ToolCallRecord, canStart?: CanStartFn): void {
		const job: PipelineJob = {
			tc,
			canStart: canStart ?? defaultCanStart,
			result: null,
			argError: null,
			done: false,
		};
		this.jobs.push(job);
		this.pending.push(job);
		this.renderBuffer?.register(tc);
		this.notify?.();
	}

	seal(): void {
		this.sealed = true;
		this.renderBuffer?.seal();
		this.notify?.();
	}

	orderedJobs(): readonly PipelineJob[] {
		return this.jobs;
	}

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
				this.notify = () => {
					this.notify = null;
					r();
				};
			});
		}
	}

	private canExecute(job: PipelineJob): boolean {
		const activeTCs = [...this.active.values()].map((j) => j.tc);
		return job.canStart(job.tc, activeTCs);
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

		run();
	}
}
