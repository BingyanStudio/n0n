/**
 * ExecutionScheduler — 流水线工具执行调度器
 *
 * 有序队列 + 队首条件等待，并行性自然涌现。
 * 各工具通过 canStart 回调声明自己的并行条件，scheduler 不感知具体工具语义。
 *
 * TODO: 移除 attachRenderBuffer 耦合，改为通过事件回调接口（onChunk、onEnd）发射 raw 事件。
 * 排序职责下放给消费者，RenderBuffer 抽离为独立工具模块。
 */

import type {
	ToolArgErrorMessage,
	ToolCallRecord,
	ToolResult,
	ToolStreamEvent,
} from "@n0n/types";
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

// ── PipelineJob — discriminated union ──

interface JobBase {
	tc: ToolCallRecord;
	canStart: CanStartFn;
}

export interface PendingJob extends JobBase {
	status: "pending";
}

export interface RunningJob extends JobBase {
	status: "running";
}

export interface CompletedJob extends JobBase {
	status: "completed";
	result: ToolResult;
}

export interface FailedJob extends JobBase {
	status: "failed";
	argError: ToolArgErrorMessage;
}

export type PipelineJob = PendingJob | RunningJob | CompletedJob | FailedJob;

// ── 工具执行函数类型 ──

export type ToolExecutor = (
	tc: ToolCallRecord,
) => AsyncGenerator<ToolStreamEvent>;

// ── ExecutionScheduler ──

export class ExecutionScheduler {
	private readonly jobs: PipelineJob[] = [];
	private readonly pendingIndices: number[] = [];
	private readonly activeIndices = new Map<string, number>();
	private sealed = false;
	private notify: (() => void) | null = null;
	private renderBuffer: RenderBuffer | null = null;

	constructor(private readonly executor: ToolExecutor) {}

	attachRenderBuffer(buf: RenderBuffer): void {
		this.renderBuffer = buf;
	}

	enqueue(tc: ToolCallRecord, canStart?: CanStartFn): void {
		const idx = this.jobs.length;
		this.jobs.push({
			status: "pending",
			tc,
			canStart: canStart ?? defaultCanStart,
		});
		this.pendingIndices.push(idx);
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
			const headIdx = this.pendingIndices[0];
			if (headIdx !== undefined) {
				const head = this.jobs[headIdx]!;
				if (head.canStart(head.tc, this.activeTCs())) {
					this.pendingIndices.shift();
					this.startJob(headIdx);
					continue;
				}
			}

			if (
				this.sealed &&
				this.pendingIndices.length === 0 &&
				this.activeIndices.size === 0
			) {
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

	private activeTCs(): ToolCallRecord[] {
		return [...this.activeIndices.values()].map((i) => this.jobs[i]!.tc);
	}

	// ── 执行启动 ──

	private startJob(idx: number): void {
		const job = this.jobs[idx]!;
		this.jobs[idx] = { ...job, status: "running" };
		this.activeIndices.set(job.tc.id, idx);

		const run = async () => {
			let result: ToolResult | null = null;
			let argError: ToolArgErrorMessage | null = null;

			try {
				for await (const event of this.executor(job.tc)) {
					if (event.type === "tool_output_chunk") {
						this.renderBuffer?.pushChunk(job.tc.id, event.tool, event.chunk);
					} else if (event.type === "tool_arg_error") {
						argError = event;
					} else {
						result = event;
					}
				}
			} catch (err) {
				if (!result && !argError) {
					argError = {
						type: "tool_arg_error",
						callId: job.tc.id,
						tool: job.tc.tool,
						error: `Internal execution error: ${err instanceof Error ? err.message : String(err)}`,
					};
				}
			} finally {
				if (argError) {
					this.jobs[idx] = {
						status: "failed",
						tc: job.tc,
						canStart: job.canStart,
						argError,
					};
				} else {
					this.jobs[idx] = {
						status: "completed",
						tc: job.tc,
						canStart: job.canStart,
						result: result!,
					};
				}
				this.activeIndices.delete(job.tc.id);
				this.renderBuffer?.pushEnd(job.tc.id, result);
				this.notify?.();
			}
		};

		run();
	}
}
