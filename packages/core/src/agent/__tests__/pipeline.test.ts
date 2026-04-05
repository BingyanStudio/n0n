/**
 * ExecutionScheduler + RenderBuffer 单元测试
 *
 * 验证调度模型：有序队列 + 队首条件等待。
 * 验证渲染模型：FIFO 有序输出缓冲。
 * 使用 mock 工具执行器，验证并行性、顺序保证、渲染缓冲等。
 */

import { describe, expect, it } from "bun:test";
import type { ToolCallRecord, ToolResult, ToolStreamEvent } from "@n0n/types";
import { ExecutionScheduler } from "../scheduler.ts";
import { RenderBuffer } from "../render-buffer.ts";

// ── Mock 工具 ──

function mockWriteTC(id: string, path: string): ToolCallRecord {
	return { id, tool: "write", args: { path, content: "test" } } as ToolCallRecord;
}

function mockEditTC(id: string, path: string): ToolCallRecord {
	return { id, tool: "edit", args: { path, intent: "test" } } as ToolCallRecord;
}

function mockExecTC(id: string): ToolCallRecord {
	return { id, tool: "exec", args: { script: "echo hi" } } as ToolCallRecord;
}

function mockReminderTC(id: string): ToolCallRecord {
	return { id, tool: "reminder", args: { content: "test" } } as ToolCallRecord;
}

function mockResult(tc: ToolCallRecord): ToolResult {
	return {
		type: "tool_result",
		tool: tc.tool,
		call: tc,
		success: true,
		error: null,
	} as unknown as ToolResult;
}

/** 创建一个可控的异步执行器：通过 resolve 回调手动控制完成时机 */
function createControllableExecutor() {
	const log: string[] = [];
	const resolvers = new Map<string, () => void>();

	const executor = async function* (tc: ToolCallRecord): AsyncGenerator<ToolStreamEvent> {
		log.push(`start:${tc.id}`);
		await new Promise<void>((r) => resolvers.set(tc.id, r));
		log.push(`end:${tc.id}`);
		yield mockResult(tc);
	};

	return {
		executor,
		log,
		resolve(id: string) {
			const r = resolvers.get(id);
			if (r) { r(); resolvers.delete(id); }
		},
	};
}

/** 创建立即完成的执行器 */
function createInstantExecutor() {
	const log: string[] = [];
	const executor = async function* (tc: ToolCallRecord): AsyncGenerator<ToolStreamEvent> {
		log.push(`exec:${tc.id}`);
		yield mockResult(tc);
	};
	return { executor, log };
}

/** 创建带 chunk 输出的可控执行器 */
function createChunkExecutor() {
	const log: string[] = [];
	const resolvers = new Map<string, () => void>();
	const chunkQueues = new Map<string, string[]>();

	const executor = async function* (tc: ToolCallRecord): AsyncGenerator<ToolStreamEvent> {
		log.push(`start:${tc.id}`);
		// 输出预设的 chunks
		const chunks = chunkQueues.get(tc.id) || [];
		for (const chunk of chunks) {
			yield { type: "tool_output_chunk", callId: tc.id, tool: tc.tool, chunk };
		}
		// 等待手动完成
		await new Promise<void>((r) => resolvers.set(tc.id, r));
		log.push(`end:${tc.id}`);
		yield mockResult(tc);
	};

	return {
		executor,
		log,
		setChunks(id: string, chunks: string[]) {
			chunkQueues.set(id, chunks);
		},
		resolve(id: string) {
			const r = resolvers.get(id);
			if (r) { r(); resolvers.delete(id); }
		},
	};
}

// ── 测试 ──

describe("ExecutionScheduler", () => {
	describe("基本调度", () => {
		it("单个工具正常执行", async () => {
			const { executor, log } = createInstantExecutor();
			const scheduler = new ExecutionScheduler(executor);
			scheduler.enqueue(mockWriteTC("w1", "a.ts"));
			scheduler.seal();
			await scheduler.run();
			expect(log).toEqual(["exec:w1"]);
			const jobs = scheduler.orderedJobs();
			expect(jobs).toHaveLength(1);
			expect(jobs[0]!.done).toBe(true);
			expect(jobs[0]!.result).not.toBeNull();
		});

		it("多个不冲突的 write/edit 并行执行", async () => {
			const { executor, log, resolve } = createControllableExecutor();
			const scheduler = new ExecutionScheduler(executor);

			scheduler.enqueue(mockEditTC("e1", "a.ts"));
			scheduler.enqueue(mockEditTC("e2", "b.ts"));
			scheduler.enqueue(mockWriteTC("w1", "c.ts"));
			scheduler.seal();

			const runPromise = scheduler.run();
			await new Promise((r) => setTimeout(r, 10));

			expect(log).toContain("start:e1");
			expect(log).toContain("start:e2");
			expect(log).toContain("start:w1");

			resolve("e1");
			resolve("e2");
			resolve("w1");
			await runPromise;

			expect(scheduler.orderedJobs().every((j) => j.done)).toBe(true);
		});

		it("相同路径的 write/edit 串行执行", async () => {
			const { executor, log, resolve } = createControllableExecutor();
			const scheduler = new ExecutionScheduler(executor);

			scheduler.enqueue(mockWriteTC("w1", "a.ts"));
			scheduler.enqueue(mockEditTC("e1", "a.ts"));
			scheduler.seal();

			const runPromise = scheduler.run();
			await new Promise((r) => setTimeout(r, 10));

			expect(log).toContain("start:w1");
			expect(log).not.toContain("start:e1");

			resolve("w1");
			await new Promise((r) => setTimeout(r, 10));
			expect(log).toContain("start:e1");

			resolve("e1");
			await runPromise;
		});
	});

	describe("exec barrier 行为", () => {
		it("exec 等待所有 active 完成", async () => {
			const { executor, log, resolve } = createControllableExecutor();
			const scheduler = new ExecutionScheduler(executor);

			scheduler.enqueue(mockEditTC("e1", "a.ts"));
			scheduler.enqueue(mockExecTC("x1"));
			scheduler.seal();

			const runPromise = scheduler.run();
			await new Promise((r) => setTimeout(r, 10));

			expect(log).toContain("start:e1");
			expect(log).not.toContain("start:x1");

			resolve("e1");
			await new Promise((r) => setTimeout(r, 10));
			expect(log).toContain("start:x1");

			resolve("x1");
			await runPromise;
		});

		it("exec 阻塞后续工具", async () => {
			const { executor, log, resolve } = createControllableExecutor();
			const scheduler = new ExecutionScheduler(executor);

			scheduler.enqueue(mockExecTC("x1"));
			scheduler.enqueue(mockEditTC("e1", "a.ts"));
			scheduler.seal();

			const runPromise = scheduler.run();
			await new Promise((r) => setTimeout(r, 10));

			expect(log).toContain("start:x1");
			expect(log).not.toContain("start:e1");

			resolve("x1");
			await new Promise((r) => setTimeout(r, 10));
			expect(log).toContain("start:e1");

			resolve("e1");
			await runPromise;
		});

		it("write/edit 在有 exec active 时被阻塞", async () => {
			const { executor, log, resolve } = createControllableExecutor();
			const scheduler = new ExecutionScheduler(executor);

			scheduler.enqueue(mockExecTC("x1"));
			scheduler.enqueue(mockWriteTC("w1", "a.ts"));
			scheduler.enqueue(mockEditTC("e1", "b.ts"));
			scheduler.seal();

			const runPromise = scheduler.run();
			await new Promise((r) => setTimeout(r, 10));

			expect(log).toEqual(["start:x1"]);

			resolve("x1");
			await new Promise((r) => setTimeout(r, 10));

			expect(log).toContain("start:w1");
			expect(log).toContain("start:e1");

			resolve("w1");
			resolve("e1");
			await runPromise;
		});
	});

	describe("reminder/submit 无条件执行", () => {
		it("reminder 可与任何工具并行", async () => {
			const { executor, log, resolve } = createControllableExecutor();
			const scheduler = new ExecutionScheduler(executor);

			scheduler.enqueue(mockEditTC("e1", "a.ts"));
			scheduler.enqueue(mockReminderTC("r1"));
			scheduler.seal();

			const runPromise = scheduler.run();
			await new Promise((r) => setTimeout(r, 10));

			expect(log).toContain("start:e1");
			expect(log).toContain("start:r1");

			resolve("e1");
			resolve("r1");
			await runPromise;
		});
	});

	describe("流式入队（模拟 streaming）", () => {
		it("streaming 过程中逐个入队，调度器实时启动", async () => {
			const { executor, log, resolve } = createControllableExecutor();
			const scheduler = new ExecutionScheduler(executor);

			const runPromise = scheduler.run();

			scheduler.enqueue(mockEditTC("e1", "a.ts"));
			await new Promise((r) => setTimeout(r, 10));
			expect(log).toContain("start:e1");

			scheduler.enqueue(mockEditTC("e2", "b.ts"));
			await new Promise((r) => setTimeout(r, 10));
			expect(log).toContain("start:e2");

			resolve("e1");
			resolve("e2");
			scheduler.seal();
			await runPromise;
		});
	});
});

describe("RenderBuffer", () => {
	it("按入队顺序渲染，即使执行乱序完成", async () => {
		const { executor, resolve } = createControllableExecutor();
		const scheduler = new ExecutionScheduler(executor);
		const renderBuffer = new RenderBuffer();
		scheduler.attachRenderBuffer(renderBuffer);

		scheduler.enqueue(mockEditTC("e1", "a.ts"));
		scheduler.enqueue(mockEditTC("e2", "b.ts"));
		scheduler.enqueue(mockWriteTC("w1", "c.ts"));
		scheduler.seal();

		const renderLog: string[] = [];
		const mockRenderer = {
			toolExecStart: (tc: ToolCallRecord) => renderLog.push(`start:${tc.id}`),
			toolExecChunk: (_tool: string, _chunk: string) => {},
			toolExecEnd: (_result: ToolResult) => renderLog.push("end"),
		};

		const runPromise = scheduler.run();
		const drainPromise = renderBuffer.drain(
			mockRenderer as any,
			() => {},
		);

		await new Promise((r) => setTimeout(r, 10));

		// e2 先完成，但 e1 是队首，e2 的事件应该被缓冲
		resolve("e2");
		await new Promise((r) => setTimeout(r, 10));

		// e1 完成，应该先渲染 e1 再渲染 e2
		resolve("e1");
		resolve("w1");
		await runPromise;
		await drainPromise;

		expect(renderLog).toEqual([
			"start:e1", "end",
			"start:e2", "end",
			"start:w1", "end",
		]);
	});

	it("队首工具的 chunk 实时流出，非队首的被缓冲", async () => {
		const { executor, resolve, setChunks } = createChunkExecutor();
		const scheduler = new ExecutionScheduler(executor);
		const renderBuffer = new RenderBuffer();
		scheduler.attachRenderBuffer(renderBuffer);

		setChunks("e1", ["chunk-a1", "chunk-a2"]);
		setChunks("e2", ["chunk-b1"]);

		scheduler.enqueue(mockEditTC("e1", "a.ts"));
		scheduler.enqueue(mockEditTC("e2", "b.ts"));
		scheduler.seal();

		const renderLog: string[] = [];
		const mockRenderer = {
			toolExecStart: (tc: ToolCallRecord) => renderLog.push(`start:${tc.id}`),
			toolExecChunk: (_tool: string, chunk: string) => renderLog.push(`chunk:${chunk}`),
			toolExecEnd: (_result: ToolResult) => renderLog.push("end"),
		};

		const runPromise = scheduler.run();
		const drainPromise = renderBuffer.drain(mockRenderer as any, () => {});

		await new Promise((r) => setTimeout(r, 10));

		// e1 的 chunks 应该已经流出（它是队首）
		expect(renderLog).toContain("start:e1");
		expect(renderLog).toContain("chunk:chunk-a1");
		expect(renderLog).toContain("chunk:chunk-a2");

		// e2 的事件应该被缓冲，不出现在 renderLog
		expect(renderLog).not.toContain("start:e2");

		resolve("e1");
		await new Promise((r) => setTimeout(r, 10));

		// e1 完成后，e2 的缓冲应该被 flush
		expect(renderLog).toContain("start:e2");
		expect(renderLog).toContain("chunk:chunk-b1");

		resolve("e2");
		await runPromise;
		await drainPromise;

		// 最终顺序验证
		expect(renderLog).toEqual([
			"start:e1", "chunk:chunk-a1", "chunk:chunk-a2", "end",
			"start:e2", "chunk:chunk-b1", "end",
		]);
	});
});
