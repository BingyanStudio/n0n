// biome-ignore-all lint/style/noNonNullAssertion: test assertions on known-shape results
// biome-ignore-all lint/suspicious/noExplicitAny: test mocks use any for flexibility
/**
 * parseStream 单元测试
 *
 * 验证流式 LLM 输出解析器的正确性：
 * - phase 状态机转换（idle → thinking → content → tool_args）
 * - 工具调用 JSON 完整性检测 → tool_ready 事件
 * - 中断处理（abort、error、length）
 * - done 事件中的汇总结果
 */

import { describe, expect, it } from "bun:test";
import type { StreamEvent } from "@n0n/types";
import { type ParsedStreamEvent, parseStream } from "../streaming.ts";

// ── 辅助 ──

/** 将 StreamEvent[] 包装为 AsyncGenerator */
async function* fakeStream(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
	for (const e of events) yield e;
}

/** 收集 parseStream 的所有输出事件 */
async function collect(
	events: StreamEvent[],
	signal?: AbortSignal,
): Promise<ParsedStreamEvent[]> {
	const result: ParsedStreamEvent[] = [];
	for await (const e of parseStream(fakeStream(events), signal)) {
		result.push(e);
	}
	return result;
}

/** 提取特定类型的事件 */
function ofType<T extends ParsedStreamEvent["type"]>(
	events: ParsedStreamEvent[],
	type: T,
): Extract<ParsedStreamEvent, { type: T }>[] {
	return events.filter((e) => e.type === type) as any;
}

// ── 测试 ──

describe("parseStream", () => {
	describe("基本 phase 转换", () => {
		it("纯 content 流：content_chunk → content_end → done", async () => {
			const events = await collect([
				{ type: "content", text: "Hello" },
				{ type: "content", text: " world" },
				{ type: "done", finishReason: "stop", usage: null },
			]);

			expect(ofType(events, "content_start")).toHaveLength(1);
			expect(ofType(events, "content_chunk")).toHaveLength(2);
			expect(ofType(events, "content_chunk")[0]!.text).toBe("Hello");
			expect(ofType(events, "content_chunk")[1]!.text).toBe(" world");
			expect(ofType(events, "content_end")).toHaveLength(1);

			const done = ofType(events, "done")[0]!;
			expect(done.result.interrupt).toBeNull();
			expect(done.result.accumulator.content).toBe("Hello world");
		});

		it("纯 thinking 流：thinking_chunk → thinking_end → done", async () => {
			const events = await collect([
				{ type: "thinking", text: "Let me think" },
				{ type: "thinking", text: "..." },
				{ type: "done", finishReason: "stop", usage: null },
			]);

			expect(ofType(events, "thinking_start")).toHaveLength(1);
			expect(ofType(events, "thinking_chunk")).toHaveLength(2);
			expect(ofType(events, "thinking_end")).toHaveLength(1);
			expect(ofType(events, "content_chunk")).toHaveLength(0);
			expect(ofType(events, "content_start")).toHaveLength(0);
		});

		it("thinking → content 转换：自动插入 thinking_end", async () => {
			const events = await collect([
				{ type: "thinking", text: "hmm" },
				{ type: "content", text: "answer" },
				{ type: "done", finishReason: "stop", usage: null },
			]);

			const types = events.map((e) => e.type);
			const thinkingStartIdx = types.indexOf("thinking_start");
			const thinkingEndIdx = types.indexOf("thinking_end");
			const contentStartIdx = types.indexOf("content_start");
			const contentChunkIdx = types.indexOf("content_chunk");
			expect(thinkingStartIdx).toBeGreaterThan(-1);
			expect(thinkingEndIdx).toBeGreaterThan(thinkingStartIdx);
			expect(contentStartIdx).toBeGreaterThan(thinkingEndIdx);
			expect(contentChunkIdx).toBeGreaterThan(contentStartIdx);
		});

		it("thinking → tool_args 转换：自动插入 thinking_end", async () => {
			const events = await collect([
				{ type: "thinking", text: "I need to run code" },
				{
					type: "tool_call_delta",
					index: 0,
					id: "tc_1",
					name: "exec",
					arguments: '{"script":"ls"}',
				},
				{ type: "done", finishReason: "tool_calls", usage: null },
			]);

			const types = events.map((e) => e.type);
			const thinkingStartIdx = types.indexOf("thinking_start");
			expect(types).toContain("thinking_end");
			const thinkingEndIdx = types.indexOf("thinking_end");
			const toolArgStartIdx = types.indexOf("tool_arg_start");
			expect(thinkingStartIdx).toBeGreaterThan(-1);
			expect(thinkingEndIdx).toBeGreaterThan(thinkingStartIdx);
			expect(toolArgStartIdx).toBeGreaterThan(thinkingEndIdx);
		});

		it("content → tool_args 转换：自动插入 content_end", async () => {
			const events = await collect([
				{ type: "content", text: "Let me check" },
				{
					type: "tool_call_delta",
					index: 0,
					id: "tc_1",
					name: "exec",
					arguments: '{"script":"ls"}',
				},
				{ type: "done", finishReason: "tool_calls", usage: null },
			]);

			const types = events.map((e) => e.type);
			const contentStartIdx = types.indexOf("content_start");
			expect(types).toContain("content_end");
			const contentEndIdx = types.indexOf("content_end");
			const toolArgStartIdx = types.indexOf("tool_arg_start");
			expect(contentStartIdx).toBeGreaterThan(-1);
			expect(contentEndIdx).toBeGreaterThan(contentStartIdx);
			expect(toolArgStartIdx).toBeGreaterThan(contentEndIdx);
		});
	});

	describe("工具调用解析", () => {
		it("单个工具调用，参数一次性完整", async () => {
			const events = await collect([
				{
					type: "tool_call_delta",
					index: 0,
					id: "tc_1",
					name: "exec",
					arguments: '{"script":"ls"}',
				},
				{ type: "done", finishReason: "tool_calls", usage: null },
			]);

			expect(ofType(events, "tool_arg_start")).toHaveLength(1);
			expect(ofType(events, "tool_arg_start")[0]!.name).toBe("exec");
			expect(ofType(events, "tool_arg_chunk")).toHaveLength(1);

			const ready = ofType(events, "tool_ready");
			expect(ready).toHaveLength(1);
			expect(ready[0]!.tc.tool).toBe("exec");
			expect(ready[0]!.tc.args).toEqual({ script: "ls" });

			const done = ofType(events, "done")[0]!;
			expect(done.result.readyTools.size).toBe(1);
		});

		it("单个工具调用，参数分片到达", async () => {
			const events = await collect([
				{
					type: "tool_call_delta",
					index: 0,
					id: "tc_1",
					name: "exec",
					arguments: '{"scr',
				},
				{ type: "tool_call_delta", index: 0, arguments: 'ipt":' },
				{ type: "tool_call_delta", index: 0, arguments: '"ls -la"}' },
				{ type: "done", finishReason: "tool_calls", usage: null },
			]);

			// tool_arg_start 只触发一次
			expect(ofType(events, "tool_arg_start")).toHaveLength(1);
			// 每个 delta 都产生 chunk
			expect(ofType(events, "tool_arg_chunk")).toHaveLength(3);
			// JSON 完整后触发 tool_ready
			const ready = ofType(events, "tool_ready");
			expect(ready).toHaveLength(1);
			expect(ready[0]!.tc.args).toEqual({ script: "ls -la" });
		});

		it("多个工具调用并行", async () => {
			const events = await collect([
				{
					type: "tool_call_delta",
					index: 0,
					id: "tc_1",
					name: "write",
					arguments: '{"path":"a.ts","content":"hello"}',
				},
				{
					type: "tool_call_delta",
					index: 1,
					id: "tc_2",
					name: "write",
					arguments: '{"path":"b.ts","content":"world"}',
				},
				{ type: "done", finishReason: "tool_calls", usage: null },
			]);

			expect(ofType(events, "tool_arg_start")).toHaveLength(2);
			expect(ofType(events, "tool_ready")).toHaveLength(2);

			const done = ofType(events, "done")[0]!;
			expect(done.result.readyTools.size).toBe(2);
		});

		it("JSON 未完整时不触发 tool_ready", async () => {
			const events = await collect([
				{
					type: "tool_call_delta",
					index: 0,
					id: "tc_1",
					name: "write",
					arguments: '{"path":"a.ts","cont',
				},
				{ type: "done", finishReason: "length", usage: null },
			]);

			expect(ofType(events, "tool_ready")).toHaveLength(0);
			const done = ofType(events, "done")[0]!;
			expect(done.result.readyTools.size).toBe(0);
			expect(done.result.interrupt).toBe("length");
		});
	});

	describe("中断处理", () => {
		it("error 事件：interrupt = error", async () => {
			const events = await collect([
				{ type: "content", text: "partial" },
				{ type: "error", error: "network failure" },
				{ type: "done", finishReason: "stop", usage: null },
			]);

			expect(ofType(events, "error")).toHaveLength(1);
			expect(ofType(events, "error")[0]!.error).toBe("network failure");

			const done = ofType(events, "done")[0]!;
			expect(done.result.interrupt).toBe("error");
		});

		it("abort signal：interrupt = aborted", async () => {
			const controller = new AbortController();

			// 创建一个会挂起的 stream，让 abort 有机会生效
			async function* slowStream(): AsyncGenerator<StreamEvent> {
				yield { type: "content", text: "start" };
				controller.abort();
				yield { type: "content", text: "after abort" };
			}

			const result: ParsedStreamEvent[] = [];
			for await (const e of parseStream(slowStream(), controller.signal)) {
				result.push(e);
			}

			const done = ofType(result, "done")[0]!;
			expect(done.result.interrupt).toBe("aborted");
		});

		it("finishReason=length → interrupt=length", async () => {
			const events = await collect([
				{ type: "content", text: "truncated output" },
				{ type: "done", finishReason: "length", usage: null },
			]);

			const done = ofType(events, "done")[0]!;
			expect(done.result.interrupt).toBe("length");
		});

		it("error 在 thinking 阶段：自动插入 thinking_end", async () => {
			const events = await collect([
				{ type: "thinking", text: "thinking..." },
				{ type: "error", error: "crash" },
				{ type: "done", finishReason: "stop", usage: null },
			]);

			const types = events.map((e) => e.type);
			const thinkingStartIdx = types.indexOf("thinking_start");
			const thinkingEndIdx = types.indexOf("thinking_end");
			const errorIdx = types.indexOf("error");
			expect(thinkingStartIdx).toBeGreaterThan(-1);
			expect(thinkingEndIdx).toBeGreaterThan(thinkingStartIdx);
			expect(thinkingEndIdx).toBeGreaterThan(-1);
			expect(errorIdx).toBeGreaterThan(thinkingEndIdx);
		});
	});

	describe("done 汇总", () => {
		it("accumulator 包含完整累积内容", async () => {
			const events = await collect([
				{ type: "thinking", text: "reason" },
				{ type: "content", text: "answer" },
				{
					type: "done",
					finishReason: "stop",
					usage: {
						inputTokens: 100,
						outputTokens: 50,
						totalTokens: 150,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
					},
				},
			]);

			const done = ofType(events, "done")[0]!;
			expect(done.result.accumulator.reasoning).toBe("reason");
			expect(done.result.accumulator.content).toBe("answer");
			expect(done.result.accumulator.usage?.inputTokens).toBe(100);
		});

		it("空流 → done 正常返回", async () => {
			const events = await collect([
				{ type: "done", finishReason: "stop", usage: null },
			]);

			expect(events).toHaveLength(1);
			const done = ofType(events, "done")[0]!;
			expect(done.result.interrupt).toBeNull();
			expect(done.result.readyTools.size).toBe(0);
		});
	});
});
