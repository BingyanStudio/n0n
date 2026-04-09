// biome-ignore-all lint/style/noNonNullAssertion: test assertions on known-shape results
// biome-ignore-all lint/suspicious/noExplicitAny: test mocks use any for flexibility
/**
 * ExecutionScheduler 单元测试
 *
 * 验证调度模型：有序队列 + 队首条件等待。
 * 验证事件回调：onRegister / onChunk / onEnd 按正确时机触发。
 * 使用 mock 工具执行器，验证并行性、顺序保证等。
 */

import { describe, expect, it } from "bun:test";
import type { CanStartFn, ToolCallRecord, ToolResult, ToolStreamEvent } from "@n0n/types";
import { ExecutionScheduler, type SchedulerEvents } from "../scheduler.ts";

// ── canStart 策略 ──

/** write/edit: 同 path 互斥，且不能与无 path 的工具并行 */
const pathExclusive: CanStartFn = (self, active) => {
	const path = (self.args as { path?: string }).path;
	for (const a of active) {
		const aPath = (a.args as { path?: string }).path;
		if (aPath === undefined) return false;
		if (aPath === path) return false;
	}
	return true;
};

/** reminder/submit: 无条件并行 */
const always: CanStartFn = () => true;

// ── Mock 工具 ──

function mockWriteTC(id: string, path: string): ToolCallRecord {
	return {
		id,
		tool: "write",
		args: { path, content: "test" },
	} as ToolCallRecord;
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

	const executor = async function* (
		tc: ToolCallRecord,
	): AsyncGenerator<ToolStreamEvent> {
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
			if (r) {
				r();
				resolvers.delete(id);
			}
		},
	};
}

/** 创建立即完成的执行器 */
function createInstantExecutor() {
	const log: string[] = [];
	const executor = async function* (
		tc: ToolCallRecord,
	): AsyncGenerator<ToolStreamEvent> {
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

	const executor = async function* (
		tc: ToolCallRecord,
	): AsyncGenerator<ToolStreamEvent> {
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
			if (r) {
				r();
				resolvers.delete(id);
			}
		},
	};
}

/** 创建事件记录器 */
function createEventLog(): { events: SchedulerEvents; log: string[] } {
	const log: string[] = [];
	return {
		log,
		events: {
			onRegister: (tc) => log.push(`register:${tc.id}`),
			onChunk: (tcId, _tool, chunk) => log.push(`chunk:${tcId}:${chunk}`),
			onEnd: (tcId, outcome) => log.push(`end:${tcId}:${outcome.status}`),
		},
	};
}

// ── 测试 ──

describe("ExecutionScheduler", () => {
	describe("基本调度", () => {
		it("单个工具正常执行", async () => {
			const { executor, log } = createInstantExecutor();
			const scheduler = new ExecutionScheduler(executor);
			scheduler.enqueue(mockWriteTC("w1", "a.ts"), pathExclusive);
			scheduler.seal();
			await scheduler.run();
			expect(log).toEqual(["exec:w1"]);
			const jobs = scheduler.orderedJobs();
			expect(jobs).toHaveLength(1);
			expect(jobs[0]!.status).toBe("completed");
		});

		it("多个不冲突的 write/edit 并行执行", async () => {
			const { executor, log, resolve } = createControllableExecutor();
			const scheduler = new ExecutionScheduler(executor);

			scheduler.enqueue(mockEditTC("e1", "a.ts"), pathExclusive);
			scheduler.enqueue(mockEditTC("e2", "b.ts"), pathExclusive);
			scheduler.enqueue(mockWriteTC("w1", "c.ts"), pathExclusive);
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

			expect(scheduler.orderedJobs().every((j) => j.status === "completed")).toBe(true);
		});

		it("相同路径的 write/edit 串行执行", async () => {
			const { executor, log, resolve } = createControllableExecutor();
			const scheduler = new ExecutionScheduler(executor);

			scheduler.enqueue(mockWriteTC("w1", "a.ts"), pathExclusive);
			scheduler.enqueue(mockEditTC("e1", "a.ts"), pathExclusive);
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

			scheduler.enqueue(mockEditTC("e1", "a.ts"), pathExclusive);
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
			scheduler.enqueue(mockEditTC("e1", "a.ts"), pathExclusive);
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
			scheduler.enqueue(mockWriteTC("w1", "a.ts"), pathExclusive);
			scheduler.enqueue(mockEditTC("e1", "b.ts"), pathExclusive);
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

			scheduler.enqueue(mockEditTC("e1", "a.ts"), pathExclusive);
			scheduler.enqueue(mockReminderTC("r1"), always);
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

			scheduler.enqueue(mockEditTC("e1", "a.ts"), pathExclusive);
			await new Promise((r) => setTimeout(r, 10));
			expect(log).toContain("start:e1");

			scheduler.enqueue(mockEditTC("e2", "b.ts"), pathExclusive);
			await new Promise((r) => setTimeout(r, 10));
			expect(log).toContain("start:e2");

			resolve("e1");
			resolve("e2");
			scheduler.seal();
			await runPromise;
		});
	});

	describe("事件回调", () => {
		it("按正确时机发射 onRegister / onEnd 事件", async () => {
			const { executor, resolve } = createControllableExecutor();
			const { events, log: eventLog } = createEventLog();
			const scheduler = new ExecutionScheduler(executor, events);

			scheduler.enqueue(mockEditTC("e1", "a.ts"), pathExclusive);
			scheduler.enqueue(mockEditTC("e2", "b.ts"), pathExclusive);
			scheduler.seal();

			const runPromise = scheduler.run();
			await new Promise((r) => setTimeout(r, 10));

			// register 事件在 enqueue 时立即触发
			expect(eventLog).toContain("register:e1");
			expect(eventLog).toContain("register:e2");

			// e2 先完成
			resolve("e2");
			await new Promise((r) => setTimeout(r, 10));
			expect(eventLog).toContain("end:e2:completed");

			// e1 后完成
			resolve("e1");
			await runPromise;
			expect(eventLog).toContain("end:e1:completed");
		});

		it("chunk 事件在执行过程中触发", async () => {
			const { executor, resolve, setChunks } = createChunkExecutor();
			const { events, log: eventLog } = createEventLog();
			const scheduler = new ExecutionScheduler(executor, events);

			setChunks("e1", ["hello", "world"]);
			scheduler.enqueue(mockEditTC("e1", "a.ts"), pathExclusive);
			scheduler.seal();

			const runPromise = scheduler.run();
			await new Promise((r) => setTimeout(r, 10));

			expect(eventLog).toContain("chunk:e1:hello");
			expect(eventLog).toContain("chunk:e1:world");

			resolve("e1");
			await runPromise;
		});

		it("事件无序到达（乱序完成）", async () => {
			const { executor, resolve } = createControllableExecutor();
			const { events, log: eventLog } = createEventLog();
			const scheduler = new ExecutionScheduler(executor, events);

			scheduler.enqueue(mockEditTC("e1", "a.ts"), pathExclusive);
			scheduler.enqueue(mockEditTC("e2", "b.ts"), pathExclusive);
			scheduler.enqueue(mockWriteTC("w1", "c.ts"), pathExclusive);
			scheduler.seal();

			const runPromise = scheduler.run();
			await new Promise((r) => setTimeout(r, 10));

			// 反向完成
			resolve("w1");
			await new Promise((r) => setTimeout(r, 10));
			resolve("e2");
			await new Promise((r) => setTimeout(r, 10));
			resolve("e1");
			await runPromise;

			// 所有 end 事件都应到达，顺序反映实际完成顺序（无序）
			const endEvents = eventLog.filter((e) => e.startsWith("end:"));
			expect(endEvents).toEqual(["end:w1:completed", "end:e2:completed", "end:e1:completed"]);
		});

		it("无 events 时 scheduler 正常工作", async () => {
			const { executor, log } = createInstantExecutor();
			const scheduler = new ExecutionScheduler(executor);
			scheduler.enqueue(mockWriteTC("w1", "a.ts"), pathExclusive);
			scheduler.seal();
			await scheduler.run();
			expect(log).toEqual(["exec:w1"]);
		});
	});
});
