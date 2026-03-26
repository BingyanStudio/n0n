/**
 * format-prompt 单元测试
 *
 * 验证 DomainMessage[] → PromptMessage[] 转换：
 * - 各种消息类型的正确映射
 * - 连续 system 消息合并
 * - tool result 格式化
 * - tool_arg_error 包含 schema
 * - XML tag 风格适配
 */

import { describe, expect, test } from "bun:test";
import type { DomainMessage, PromptMessage } from "@n0n/types";
import { formatPrompt } from "../format-prompt.ts";

const MODEL = "gpt-4o";

describe("formatPrompt", () => {
	test("system 消息映射为 role: system", () => {
		const msgs: DomainMessage[] = [
			{ type: "system", content: "You are a helpful assistant." },
		];
		const result = formatPrompt(msgs, MODEL);
		expect(result).toHaveLength(1);
		expect(result[0]!.role).toBe("system");
		if (result[0]!.role === "system") {
			expect(result[0]!.content).toContain("helpful assistant");
		}
	});

	test("user_text 消息映射为 role: user", () => {
		const msgs: DomainMessage[] = [
			{ type: "user_text", content: "Hello" },
		];
		const result = formatPrompt(msgs, MODEL);
		expect(result).toHaveLength(1);
		expect(result[0]!.role).toBe("user");
	});

	test("assistant_text 消息映射为 role: assistant", () => {
		const msgs: DomainMessage[] = [
			{
				type: "assistant_text",
				content: "I'll help you.",
				reasoning: "thinking...",
				reasoningSignature: "sig_abc",
			},
		];
		const result = formatPrompt(msgs, MODEL);
		expect(result).toHaveLength(1);
		expect(result[0]!.role).toBe("assistant");
		if (result[0]!.role === "assistant") {
			expect(result[0]!.content).toBe("I'll help you.");
			expect(result[0]!.reasoning).toBe("thinking...");
			expect(result[0]!.reasoningSignature).toBe("sig_abc");
		}
	});

	test("assistant_tool_call 消息包含 toolCalls", () => {
		const msgs: DomainMessage[] = [
			{
				type: "assistant_tool_call",
				content: "Let me run that.",
				reasoning: null,
				reasoningSignature: null,
				toolCalls: [
					{
						id: "tc_1",
						tool: "exec",
						args: { script: "ls" },
					},
				],
			},
		];
		const result = formatPrompt(msgs, MODEL);
		expect(result).toHaveLength(1);
		expect(result[0]!.role).toBe("assistant");
		if (result[0]!.role === "assistant") {
			expect(result[0]!.toolCalls).toHaveLength(1);
			expect(result[0]!.toolCalls![0]!.tool).toBe("exec");
		}
	});

	test("连续 system 消息合并", () => {
		const msgs: DomainMessage[] = [
			{ type: "system", content: "Rule 1" },
			{ type: "system", content: "Rule 2" },
			{ type: "user_text", content: "Hi" },
		];
		const result = formatPrompt(msgs, MODEL);
		expect(result).toHaveLength(2);
		expect(result[0]!.role).toBe("system");
		if (result[0]!.role === "system") {
			expect(result[0]!.content).toContain("Rule 1");
			expect(result[0]!.content).toContain("Rule 2");
		}
		expect(result[1]!.role).toBe("user");
	});

	test("idle_nudge 消息映射为 user warning", () => {
		const msgs: DomainMessage[] = [
			{ type: "idle_nudge", idleCount: 2, maxIdleRounds: 5 },
		];
		const result = formatPrompt(msgs, MODEL);
		expect(result).toHaveLength(1);
		expect(result[0]!.role).toBe("user");
		if (result[0]!.role === "user") {
			expect(result[0]!.content).toContain("2/5");
			expect(result[0]!.content).toContain("tools");
		}
	});

	test("reminder:due 消息映射", () => {
		const msgs: DomainMessage[] = [
			{
				type: "reminder:due",
				content: "Check progress",
				originalDelay: 3,
			},
		];
		const result = formatPrompt(msgs, MODEL);
		expect(result).toHaveLength(1);
		expect(result[0]!.role).toBe("user");
		if (result[0]!.role === "user") {
			expect(result[0]!.content).toContain("Check progress");
			expect(result[0]!.content).toContain("3 rounds ago");
		}
	});

	test("submit:rejected 消息映射", () => {
		const msgs: DomainMessage[] = [
			{
				type: "submit:rejected",
				error: "Missing field",
				attempt: 1,
				maxAttempts: 4,
			},
		];
		const result = formatPrompt(msgs, MODEL);
		expect(result).toHaveLength(1);
		expect(result[0]!.role).toBe("user");
		if (result[0]!.role === "user") {
			expect(result[0]!.content).toContain("Missing field");
			expect(result[0]!.content).toContain("1/4");
		}
	});

	test("tool_arg_error 包含 schema 信息", () => {
		const msgs: DomainMessage[] = [
			{
				type: "tool_arg_error",
				callId: "tc_1",
				tool: "exec",
				error: "script: Required",
				schema: {
					type: "object",
					properties: { script: { type: "string" } },
					required: ["script"],
				},
			},
		];
		const result = formatPrompt(msgs, MODEL);
		expect(result).toHaveLength(1);
		expect(result[0]!.role).toBe("tool");
		if (result[0]!.role === "tool") {
			expect(result[0]!.toolName).toBe("exec");
			expect(result[0]!.content).toContain("Invalid tool arguments");
			expect(result[0]!.content).toContain("Expected schema");
			expect(result[0]!.content).toContain('"script"');
		}
	});

	test("tool_arg_error 无 schema 时不包含 schema 信息", () => {
		const msgs: DomainMessage[] = [
			{
				type: "tool_arg_error",
				callId: "tc_1",
				tool: "exec",
				error: "script: Required",
			},
		];
		const result = formatPrompt(msgs, MODEL);
		expect(result).toHaveLength(1);
		if (result[0]!.role === "tool") {
			expect(result[0]!.content).toContain("Invalid tool arguments");
			expect(result[0]!.content).not.toContain("Expected schema");
		}
	});

	test("user_input 消息拼接 context/hint", () => {
		const msgs: DomainMessage[] = [
			{
				type: "user_input",
				content: "Fix the bug",
				context: "Project context here",
				hint: "Start by reading the code",
			},
		];
		const result = formatPrompt(msgs, MODEL);
		expect(result).toHaveLength(1);
		expect(result[0]!.role).toBe("user");
		if (result[0]!.role === "user") {
			expect(result[0]!.content).toContain("Project context here");
			expect(result[0]!.content).toContain("Fix the bug");
			expect(result[0]!.content).toContain("Start by reading the code");
		}
	});

	test("user_image 降级为文本占位", () => {
		const msgs: DomainMessage[] = [
			{
				type: "user_image",
				text: "What is this?",
				imagePath: "/tmp/img.png",
				focusX: 0,
				focusY: 0,
				scale: 1,
			},
		];
		const result = formatPrompt(msgs, MODEL);
		expect(result).toHaveLength(1);
		expect(result[0]!.role).toBe("user");
		if (result[0]!.role === "user") {
			expect(result[0]!.content).toContain("/tmp/img.png");
			expect(result[0]!.content).toContain("What is this?");
		}
	});

	test("exec tool_result 格式化", () => {
		const msgs: DomainMessage[] = [
			{
				type: "tool_result",
				tool: "exec",
				call: {
					id: "tc_1",
					tool: "exec",
					args: { script: "echo hello", runtime: "cmd", cwd: "." },
				},
				exitCode: 0,
				stdout: "hello",
				stderr: "",
				durationMs: 50,
			},
		];
		const result = formatPrompt(msgs, MODEL);
		expect(result).toHaveLength(1);
		expect(result[0]!.role).toBe("tool");
		if (result[0]!.role === "tool") {
			expect(result[0]!.toolCallId).toBe("tc_1");
			expect(result[0]!.content).toContain("hello");
			expect(result[0]!.content).toContain("exit: 0");
		}
	});
});
