/**
 * DeepSeek directive 拦截与注入测试
 *
 * 直接导入 deepseek/ 模块的公共 API，不复制实现。
 */

import { describe, expect, it } from "bun:test";
import { formatPrompt } from "@n0n/shared";
import type { DomainMessage } from "@n0n/types";
import {
	DeepSeekCollectingAdapter,
	injectDirectives,
	toDeepSeekMessages,
} from "../deepseek/index.ts";
import type { DeepSeekMessage } from "../deepseek/index.ts";
import { createTagAdapter } from "@n0n/shared";

// ── 辅助函数 ──

/** 完整管线：DomainMessage[] → 拦截 → 格式化 → 转换 → 注入 */
function pipeline(messages: DomainMessage[]): DeepSeekMessage[] {
	const base = createTagAdapter("default");
	const adapter = new DeepSeekCollectingAdapter(base);
	const prompt = formatPrompt(messages, adapter);
	const raw = toDeepSeekMessages(prompt, false);
	return injectDirectives(raw, adapter.directives());
}

function messagesOfRole(
	msgs: DeepSeekMessage[],
	role: string,
): DeepSeekMessage[] {
	return msgs.filter((m) => m.role === role);
}

// ── 测试 ──

describe("injectDirectives hint 位置对齐", () => {
	it("单轮 user_input + hint：hint 紧跟对应 user 消息", () => {
		const result = pipeline([
			{ type: "system", content: "You are helpful." },
			{
				type: "user_input",
				content: "问题1",
				context: null,
				hint: "提示1",
			},
		]);

		const roles = result.map((m) => m.role);
		const userIdx = roles.indexOf("user");
		const devIdx = roles.indexOf("developer");

		expect(devIdx).toBe(userIdx + 1);
	});

	it("多轮 user_input 各自带 hint：仅保留最后一轮 hint", () => {
		const result = pipeline([
			{ type: "system", content: "You are helpful." },
			{
				type: "user_input",
				content: "问题1",
				context: null,
				hint: "提示1",
			},
			{
				type: "assistant_text",
				content: "回复1",
				reasoning: null,
				reasoningSignature: null,
			},
			{
				type: "user_input",
				content: "问题2",
				context: null,
				hint: "提示2",
			},
		]);

		const devMsgs = messagesOfRole(result, "developer");
		expect(devMsgs).toHaveLength(1);
		expect(devMsgs[0]!.content).toBe("提示2");

		const lastMsg = result[result.length - 1]!;
		expect(lastMsg.role).toBe("developer");
		expect(lastMsg.content).toBe("提示2");
	});

	it("三轮对话：仅保留最后一个 assistant 之后的 hint", () => {
		const result = pipeline([
			{ type: "system", content: "You are helpful." },
			{ type: "user_input", content: "Q1", context: null, hint: "H1" },
			{
				type: "assistant_text",
				content: "A1",
				reasoning: null,
				reasoningSignature: null,
			},
			{ type: "user_input", content: "Q2", context: null, hint: "H2" },
			{
				type: "assistant_text",
				content: "A2",
				reasoning: null,
				reasoningSignature: null,
			},
			{ type: "user_input", content: "Q3", context: null, hint: "H3" },
		]);

		const devMsgs = messagesOfRole(result, "developer");
		expect(devMsgs).toHaveLength(1);
		expect(devMsgs[0]!.content).toBe("H3");

		const lastMsg = result[result.length - 1]!;
		expect(lastMsg.role).toBe("developer");

		const contents = result.map((m) => m.content);
		expect(contents.indexOf("H3")).toBeGreaterThan(contents.indexOf("A2"));
	});
});

describe("injectDirectives A 类 directive 位置", () => {
	it("idle_nudge → developer 替换空 user", () => {
		const result = pipeline([
			{ type: "system", content: "You are helpful." },
			{ type: "user_input", content: "问题", context: null, hint: null },
			{
				type: "assistant_text",
				content: "回复",
				reasoning: null,
				reasoningSignature: null,
			},
			{ type: "idle_nudge", idleCount: 1, maxIdleRounds: 5 },
		]);

		const devMsgs = messagesOfRole(result, "developer");
		expect(devMsgs).toHaveLength(1);

		const contents = result.map((m) => m.content);
		const devIdx = result.findIndex((m) => m.role === "developer");
		const replyIdx = contents.indexOf("回复");
		expect(devIdx).toBeGreaterThan(replyIdx);

		const emptyUsers = result.filter(
			(m) => m.role === "user" && !(m.content ?? "").trim(),
		);
		expect(emptyUsers).toHaveLength(0);
	});

	it("reminder:due → latest_reminder", () => {
		const result = pipeline([
			{ type: "system", content: "You are helpful." },
			{ type: "user_input", content: "问题", context: null, hint: null },
			{
				type: "assistant_text",
				content: "回复",
				reasoning: null,
				reasoningSignature: null,
			},
			{
				type: "reminder:due",
				content: "检查结果",
				originalEstimate: 3,
			},
		]);

		const lrMsgs = messagesOfRole(result, "latest_reminder");
		expect(lrMsgs).toHaveLength(1);
		expect(lrMsgs[0]!.content).toContain("检查结果");
	});
});

describe("injectDirectives C 类 directive（嵌在 tool result 中）", () => {
	it("diagnostic_hint 从 exec result 中提取，不丢失", () => {
		const result = pipeline([
			{ type: "system", content: "You are helpful." },
			{
				type: "user_input",
				content: "帮我安装包",
				context: null,
				hint: null,
			},
			{
				type: "assistant_tool_call",
				content: null,
				reasoning: null,
				reasoningSignature: null,
				toolCalls: [
					{
						id: "tc_1",
						tool: "exec",
						args: { script: "npm install foo" },
					},
				],
			},
			{
				type: "tool_result",
				tool: "exec",
				status: "completed",
				call: {
					id: "tc_1",
					tool: "exec",
					args: { script: "npm install foo" },
				},
				exitCode: 1,
				stdout: "",
				stderr: "Cannot find module 'foo'",
				durationMs: 100,
			} as DomainMessage,
			{
				type: "user_input",
				content: "换个方式试试",
				context: null,
				hint: null,
			},
		]);

		const devMsgs = messagesOfRole(result, "developer");
		const hasDiagnostic = devMsgs.some(
			(m) =>
				(m.content ?? "").toLowerCase().includes("module") ||
				(m.content ?? "").toLowerCase().includes("package"),
		);
		expect(hasDiagnostic).toBe(true);

		const toolIdx = result.findIndex((m) => m.role === "tool");
		const diagIdx = result.findIndex(
			(m) =>
				m.role === "developer" &&
				((m.content ?? "").toLowerCase().includes("module") ||
					(m.content ?? "").toLowerCase().includes("package")),
		);
		expect(diagIdx).toBeGreaterThan(toolIdx);
	});
});

describe("injectDirectives 不破坏 tool_calls→tool_result 连续性", () => {
	/** assistant(tool_calls=N) 后的 N 条消息必须全部是 tool role */
	function checkToolCallIntegrity(
		msgs: DeepSeekMessage[],
	): { ok: boolean; issue?: string } {
		for (let i = 0; i < msgs.length; i++) {
			const msg = msgs[i]!;
			if (
				msg.role === "assistant" &&
				msg.tool_calls &&
				msg.tool_calls.length > 0
			) {
				const n = msg.tool_calls.length;
				for (let j = 1; j <= n; j++) {
					const next = msgs[i + j]!;
					if (!next || next.role !== "tool") {
						return {
							ok: false,
							issue: `[${i}] assistant has ${n} tool_calls, but [${i + j}] is ${next?.role ?? "missing"}`,
						};
					}
				}
			}
		}
		return { ok: true };
	}

	it("truncated exec（含 output_hint）不应在 tool 消息间插入 developer", () => {
		const result = pipeline([
			{ type: "system", content: "You are helpful." },
			{ type: "user_input", content: "请执行", context: null, hint: null },
			{
				type: "assistant_tool_call",
				content: null,
				reasoning: null,
				reasoningSignature: null,
				toolCalls: [
					{ id: "tc_1", tool: "exec", args: { script: "git diff HEAD" } },
					{ id: "tc_2", tool: "exec", args: { script: "echo ok" } },
					{ id: "tc_3", tool: "exec", args: { script: "git log" } },
					{
						id: "tc_4",
						tool: "exec",
						args: { script: "git diff HEAD~3" },
					},
				],
			},
			{
				type: "tool_result",
				tool: "exec",
				status: "truncated",
				call: {
					id: "tc_1",
					tool: "exec",
					args: { script: "git diff HEAD" },
				},
				exitCode: 0,
				stdoutTail: "last 100 lines...",
				stderrTail: "",
				outputFile: "/tmp/exec_output_abc.txt",
				stdoutLength: 16000,
				stderrLength: 0,
				totalLines: 500,
				tailStartLine: 400,
				truncatedChunks: [
					{ startLine: 1, endLine: 200, tokens: 2000 },
					{ startLine: 201, endLine: 399, tokens: 1800 },
				],
				durationMs: 200,
			} as DomainMessage,
			{
				type: "tool_result",
				tool: "exec",
				status: "completed",
				call: {
					id: "tc_2",
					tool: "exec",
					args: { script: "echo ok" },
				},
				exitCode: 0,
				stdout: "ok",
				stderr: "",
				durationMs: 50,
			} as DomainMessage,
			{
				type: "tool_result",
				tool: "exec",
				status: "completed",
				call: {
					id: "tc_3",
					tool: "exec",
					args: { script: "git log" },
				},
				exitCode: 0,
				stdout: "commit abc...",
				stderr: "",
				durationMs: 80,
			} as DomainMessage,
			{
				type: "tool_result",
				tool: "exec",
				status: "truncated",
				call: {
					id: "tc_4",
					tool: "exec",
					args: { script: "git diff HEAD~3" },
				},
				exitCode: 0,
				stdoutTail: "another tail...",
				stderrTail: "",
				outputFile: "/tmp/exec_output_def.txt",
				stdoutLength: 20000,
				stderrLength: 0,
				totalLines: 700,
				tailStartLine: 500,
				truncatedChunks: [
					{ startLine: 1, endLine: 250, tokens: 2500 },
					{ startLine: 251, endLine: 499, tokens: 2200 },
				],
				durationMs: 300,
			} as DomainMessage,
		]);

		const integrity = checkToolCallIntegrity(result);
		expect(integrity.ok).toBe(true);

		const devMsgs = messagesOfRole(result, "developer");
		expect(devMsgs.length).toBeGreaterThanOrEqual(1);

		const lastToolIdx = result.reduce(
			(acc, m, i) => (m.role === "tool" ? i : acc),
			-1,
		);
		for (const dev of devMsgs) {
			const devIdx = result.indexOf(dev);
			expect(devIdx).toBeGreaterThan(lastToolIdx);
		}
	});

	it("多轮 tool_calls + truncated：早期轮次的 directive 被 strip", () => {
		const result = pipeline([
			{ type: "system", content: "You are helpful." },
			{ type: "user_input", content: "开始", context: null, hint: null },
			{
				type: "assistant_tool_call",
				content: null,
				reasoning: null,
				reasoningSignature: null,
				toolCalls: [
					{ id: "a1", tool: "exec", args: { script: "cmd1" } },
				],
			},
			{
				type: "tool_result",
				tool: "exec",
				status: "truncated",
				call: { id: "a1", tool: "exec", args: { script: "cmd1" } },
				exitCode: 0,
				stdoutTail: "tail...",
				stderrTail: "",
				outputFile: "/tmp/out1.txt",
				stdoutLength: 10000,
				stderrLength: 0,
				totalLines: 300,
				tailStartLine: 200,
				truncatedChunks: [
					{ startLine: 1, endLine: 199, tokens: 1500 },
				],
				durationMs: 100,
			} as DomainMessage,
			{
				type: "assistant_tool_call",
				content: null,
				reasoning: null,
				reasoningSignature: null,
				toolCalls: [
					{ id: "b1", tool: "exec", args: { script: "cmd2" } },
				],
			},
			{
				type: "tool_result",
				tool: "exec",
				status: "truncated",
				call: { id: "b1", tool: "exec", args: { script: "cmd2" } },
				exitCode: 0,
				stdoutTail: "tail2...",
				stderrTail: "",
				outputFile: "/tmp/out2.txt",
				stdoutLength: 8000,
				stderrLength: 0,
				totalLines: 250,
				tailStartLine: 150,
				truncatedChunks: [
					{ startLine: 1, endLine: 149, tokens: 1200 },
				],
				durationMs: 90,
			} as DomainMessage,
		]);

		const integrity = checkToolCallIntegrity(result);
		expect(integrity.ok).toBe(true);

		const devMsgs = messagesOfRole(result, "developer");
		expect(devMsgs.length).toBeGreaterThanOrEqual(1);

		const lastNonDev = result.reduce(
			(acc, m, i) => (m.role !== "developer" ? i : acc),
			-1,
		);
		for (let i = 0; i < result.length; i++) {
			if (result[i]!.role === "developer") {
				expect(i).toBeGreaterThan(lastNonDev);
			}
		}
	});
});
