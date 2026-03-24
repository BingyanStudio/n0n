/**
 * StreamAccumulator 单元测试
 *
 * 验证流式事件累积的正确性：
 * - 基本 content/thinking 累积
 * - tool_call_delta 的 index 合并
 * - thinking_signature 处理
 * - done 事件记录 finishReason 和 usage
 * - toMessage() 输出格式
 */

import { describe, expect, test } from "bun:test";
import { StreamAccumulator } from "../client.ts";
import type { StreamEvent } from "../client.ts";

describe("StreamAccumulator", () => {
	test("累积 content 事件", () => {
		const acc = new StreamAccumulator();
		acc.push({ type: "content", text: "Hello" });
		acc.push({ type: "content", text: " world" });

		expect(acc.content).toBe("Hello world");
		const msg = acc.toMessage();
		expect(msg.content).toBe("Hello world");
	});

	test("累积 thinking 事件", () => {
		const acc = new StreamAccumulator();
		acc.push({ type: "thinking", text: "Let me think" });
		acc.push({ type: "thinking", text: "..." });

		expect(acc.reasoning).toBe("Let me think...");
		const msg = acc.toMessage();
		expect(msg.reasoningText).toBe("Let me think...");
	});

	test("thinking_signature 事件", () => {
		const acc = new StreamAccumulator();
		acc.push({ type: "thinking", text: "some reasoning" });
		acc.push({ type: "thinking_signature", signature: "sig_abc123" });

		expect(acc.reasoningSignature).toBe("sig_abc123");
		const msg = acc.toMessage();
		expect(msg.reasoningSignature).toBe("sig_abc123");
	});

	test("tool_call_delta 按 index 合并", () => {
		const acc = new StreamAccumulator();
		acc.push({
			type: "tool_call_delta",
			index: 0,
			id: "call_1",
			name: "exec",
			arguments: '{"scr',
		});
		acc.push({
			type: "tool_call_delta",
			index: 0,
			arguments: 'ipt":"ls"}',
		});
		acc.push({
			type: "tool_call_delta",
			index: 1,
			id: "call_2",
			name: "write",
			arguments: '{"path":"a.txt"}',
		});

		const msg = acc.toMessage();
		expect(msg.toolCalls).toHaveLength(2);
		expect(msg.toolCalls[0].toolCallId).toBe("call_1");
		expect(msg.toolCalls[0].toolName).toBe("exec");
		expect(msg.toolCalls[0].input).toBe('{"script":"ls"}');
		expect(msg.toolCalls[1].toolCallId).toBe("call_2");
		expect(msg.toolCalls[1].toolName).toBe("write");
	});

	test("done 事件记录 finishReason 和 usage", () => {
		const acc = new StreamAccumulator();
		acc.push({ type: "content", text: "hi" });
		acc.push({
			type: "done",
			finishReason: "stop",
			usage: {
				inputTokens: 100,
				outputTokens: 50,
				totalTokens: 150,
				cacheReadTokens: 10,
				cacheWriteTokens: 5,
			},
		});

		expect(acc.finishReason).toBe("stop");
		expect(acc.usage).not.toBeNull();
		expect(acc.usage!.inputTokens).toBe(100);
		expect(acc.usage!.outputTokens).toBe(50);
	});

	test("空内容 toMessage 返回 null content", () => {
		const acc = new StreamAccumulator();
		acc.push({ type: "done", finishReason: "stop", usage: null });

		const msg = acc.toMessage();
		expect(msg.content).toBeNull();
		expect(msg.reasoningText).toBeNull();
		expect(msg.toolCalls).toHaveLength(0);
	});

	test("error 事件不累积", () => {
		const acc = new StreamAccumulator();
		acc.push({ type: "content", text: "partial" });
		acc.push({ type: "error", error: "network failure" });

		expect(acc.content).toBe("partial");
		expect(acc.finishReason).toBeNull();
	});

	test("完整流式场景：thinking + content + tool_call + done", () => {
		const acc = new StreamAccumulator();
		const events: StreamEvent[] = [
			{ type: "thinking", text: "I should run a command" },
			{ type: "thinking_signature", signature: "sig_xyz" },
			{ type: "content", text: "Let me check" },
			{
				type: "tool_call_delta",
				index: 0,
				id: "tc_1",
				name: "exec",
				arguments: '{"script":',
			},
			{
				type: "tool_call_delta",
				index: 0,
				arguments: '"ls -la"}',
			},
			{
				type: "done",
				finishReason: "tool_calls",
				usage: {
					inputTokens: 200,
					outputTokens: 100,
					totalTokens: 300,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
				},
			},
		];

		for (const e of events) acc.push(e);

		const msg = acc.toMessage();
		expect(msg.role).toBe("assistant");
		expect(msg.reasoningText).toBe("I should run a command");
		expect(msg.reasoningSignature).toBe("sig_xyz");
		expect(msg.content).toBe("Let me check");
		expect(msg.toolCalls).toHaveLength(1);
		expect(msg.toolCalls[0].toolName).toBe("exec");
		expect(msg.toolCalls[0].input).toBe('{"script":"ls -la"}');
		expect(acc.finishReason).toBe("tool_calls");
	});
});
