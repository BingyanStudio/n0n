/**
 * ExecutionScheduler — 流水线工具执行调度器
 *
 * 有序队列 + 队首条件等待，并行性自然涌现。
 *
 * 执行条件：
 *   write/edit(path) → active 中没有相同 path 且没有 exec
 *   exec             → active 为空
 *   reminder/submit  → 无条件
 *
 * TODO 当前通过 attachRenderBuffer 与 RenderBuffer 耦合，且 startJob 直接推送渲染事件。
 * 后续应考虑通过事件回调接口进一步解耦调度与渲染，使两者可独立测试和替换。
 */

import type {
	ToolCallRecord,
	ToolResult,
	ToolStreamEvent,
} from "@n0n/types";
import type { RenderBuffer } from "./render-buffer.ts";

// ── PipelineJob ──

/** 单个工具执行的状态 */
export interface PipelineJob {
	tc: ToolCallRecord;
	result: ToolResult | null;
	argError: { type: "tool_arg_error"; callId: string; tool: string; error: string; schema?: Record<string, unknown> } | null;
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

	enqueue(tc: ToolCallRecord): void {
		const job: PipelineJob = { tc, result: null, argError: null, done: false };
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
				this.notify = () => { this.notify = null; r(); };
			});
		}
	}

	// ── 条件检查 ──
	// TODO 基于约定的硬编码：canExecute 通过 switch(tc.tool) 硬编码了每种工具的并行策略。
	// 应改为 ToolEntry 上声明 canExecute 回调：(self: ToolCallRecord, active: ToolCallRecord[]) => boolean，
	// scheduler 直接调用回调，不再依赖工具名字符串。

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
