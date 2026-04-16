/**
 * RenderBuffer 单元测试
 *
 * 验证 FIFO 有序输出缓冲的核心行为：
 * - 按入队顺序输出（即使工具乱序完成）
 * - pause/resume 控制
 * - argError 跳过
 */

import { describe, expect, test } from "bun:test";
import type { ToolCallRecord, ToolResult } from "@n0n/types";
import { RenderBuffer, type RenderSink } from "../render-buffer.ts";

// ── helpers ──

function mockTC(id: string): ToolCallRecord {
	return { id, tool: "exec", args: { script: "echo" } } as ToolCallRecord;
}

function mockResult(id: string): ToolResult {
	return {
		type: "tool_result",
		tool: "exec",
		call: mockTC(id),
		status: "completed",
		exitCode: 0,
		stdout: "",
		stderr: "",
		durationMs: 10,
	} as ToolResult;
}

function createSink(): { sink: RenderSink; log: string[] } {
	const log: string[] = [];
	return {
		log,
		sink: {
			onStart: (tc) => log.push(`start:${tc.id}`),
			onChunk: (tool, chunk) => log.push(`chunk:${tool}:${chunk}`),
			onEnd: (result) => log.push(`end:${result.call.id}`),
		},
	};
}

// ── tests ──

describe("RenderBuffer", () => {
	test("单个工具：register → chunk → end 按序输出", () => {
		const { sink, log } = createSink();
		const buf = new RenderBuffer(sink);
		const tc = mockTC("a");

		buf.resume();
		buf.register(tc);
		buf.pushChunk("a", "exec", "hello");
		buf.pushEnd("a", { status: "completed", result: mockResult("a") });

		expect(log).toEqual(["start:a", "chunk:exec:hello", "end:a"]);
	});

	test("FIFO 顺序：第二个工具先完成，但在第一个之后输出", () => {
		const { sink, log } = createSink();
		const buf = new RenderBuffer(sink);

		buf.resume();
		buf.register(mockTC("a"));
		buf.register(mockTC("b"));

		// b 先完成
		buf.pushEnd("b", { status: "completed", result: mockResult("b") });
		// b 的 end 应该被缓冲，a 还没完成
		expect(log).toEqual(["start:a"]);

		// a 完成，flush a 然后 b
		buf.pushEnd("a", { status: "completed", result: mockResult("a") });
		expect(log).toEqual(["start:a", "end:a", "start:b", "end:b"]);
	});

	test("pause 状态下所有事件暂存，resume 时一次性 flush", () => {
		const { sink, log } = createSink();
		const buf = new RenderBuffer(sink);

		// 默认 paused
		buf.register(mockTC("a"));
		buf.pushChunk("a", "exec", "data");
		buf.pushEnd("a", { status: "completed", result: mockResult("a") });

		expect(log).toEqual([]);

		buf.resume();
		expect(log).toEqual(["start:a", "chunk:exec:data", "end:a"]);
	});

	test("argError 跳过不渲染，推进到下一个工具", () => {
		const { sink, log } = createSink();
		const buf = new RenderBuffer(sink);

		buf.resume();
		buf.register(mockTC("a"));
		buf.register(mockTC("b"));

		// a 是 argError
		buf.pushEnd("a", { status: "arg_error" });
		// a 被跳过，b 成为队首
		buf.pushEnd("b", { status: "completed", result: mockResult("b") });

		expect(log).toEqual(["start:a", "start:b", "end:b"]);
	});

	test("中间工具 argError，前后工具正常输出", () => {
		const { sink, log } = createSink();
		const buf = new RenderBuffer(sink);

		buf.resume();
		buf.register(mockTC("a"));
		buf.register(mockTC("b"));
		buf.register(mockTC("c"));

		buf.pushEnd("a", { status: "completed", result: mockResult("a") });
		buf.pushEnd("b", { status: "arg_error" });
		buf.pushEnd("c", { status: "completed", result: mockResult("c") });

		expect(log).toEqual([
			"start:a",
			"end:a",
			"start:b", // b gets onStart when it becomes head after a completes
			"start:c",
			"end:c",
		]);
	});

	test("队首工具的 chunk 实时输出，非队首暂存", () => {
		const { sink, log } = createSink();
		const buf = new RenderBuffer(sink);

		buf.resume();
		buf.register(mockTC("a"));
		buf.register(mockTC("b"));

		buf.pushChunk("a", "exec", "a1");
		buf.pushChunk("b", "exec", "b1"); // 非队首，暂存

		expect(log).toEqual(["start:a", "chunk:exec:a1"]);

		buf.pushEnd("a", { status: "completed", result: mockResult("a") });
		// a 完成后 b 被 flush
		expect(log).toEqual([
			"start:a",
			"chunk:exec:a1",
			"end:a",
			"start:b",
			"chunk:exec:b1",
		]);

		buf.pushEnd("b", { status: "completed", result: mockResult("b") });
		expect(log).toEqual([
			"start:a",
			"chunk:exec:a1",
			"end:a",
			"start:b",
			"chunk:exec:b1",
			"end:b",
		]);
	});

	test("reset 清除所有状态", () => {
		const { sink, log } = createSink();
		const buf = new RenderBuffer(sink);

		buf.resume();
		buf.register(mockTC("a"));
		buf.pushChunk("a", "exec", "data");

		buf.reset();
		// reset 后 push 已注册的 id 被忽略
		buf.pushEnd("a", { status: "completed", result: mockResult("a") });
		expect(log).toEqual(["start:a", "chunk:exec:data"]);
	});

	test("未知 tcId 的 push 被静默忽略", () => {
		const { sink, log } = createSink();
		const buf = new RenderBuffer(sink);

		buf.resume();
		buf.pushChunk("unknown", "exec", "data");
		buf.pushEnd("unknown", { status: "completed", result: mockResult("x") });

		expect(log).toEqual([]);
	});
});
