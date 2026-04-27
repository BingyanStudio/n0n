/**
 * DeepSeek CollectingTagAdapter + injectDirectives 测试
 *
 * 验证控制性 tag 被正确拦截并注入为 developer/latest_reminder 消息，
 * 且 directive 的位置与其来源消息对齐（不提前、不错位）。
 */

import { describe, expect, it } from "bun:test";
import { formatPrompt } from "@n0n/shared";
import { createTagAdapter } from "@n0n/shared";
import type { DomainMessage } from "@n0n/types";

// ── 复制内部实现（与 deepseek-client.ts 保持一致） ──

const DIRECTIVE_TAGS = new Set([
	"hint",
	"system_warning",
	"submit_rejected",
	"turn_feedback",
	"reminder",
	"edit_feedback",
	"diagnostic_hint",
	"output_hint",
]);

interface CollectedDirective {
	tag: string;
	content: string;
}

const DIRECTIVE_PLACEHOLDER_RE = /🔮⟪DIR:(\d+)⟫🔮/g;

class TestCollectingAdapter {
	private readonly base = createTagAdapter("default");
	private readonly collected: CollectedDirective[] = [];

	wrapTag(name: string, content: string): string {
		if (DIRECTIVE_TAGS.has(name)) {
			const idx = this.collected.length;
			this.collected.push({ tag: name, content });
			return `🔮⟪DIR:${idx}⟫🔮`;
		}
		return this.base.wrapTag(name, content);
	}

	adaptTags(text: string): string {
		return this.base.adaptTags(text);
	}

	directives(): readonly CollectedDirective[] {
		return this.collected;
	}
}

interface TestMessage {
	role: string;
	content: string | null;
	tool_call_id?: string;
	tool_calls?: unknown[];
	task?: string;
}

function toTestMessages(
	promptMessages: ReturnType<typeof formatPrompt>,
): TestMessage[] {
	return promptMessages.map((m) => {
		if (m.role === "assistant") {
			const a = m as Extract<typeof m, { role: "assistant" }>;
			return {
				role: "assistant",
				content: a.content || null,
				...(a.toolCalls?.length ? { tool_calls: a.toolCalls } : {}),
			};
		}
		if (m.role === "tool") {
			const t = m as Extract<typeof m, { role: "tool" }>;
			return {
				role: "tool",
				content: t.content,
				tool_call_id: t.toolCallId,
			};
		}
		return { role: m.role, content: m.content };
	});
}

function injectDirectives(
	messages: TestMessage[],
	directives: readonly CollectedDirective[],
): TestMessage[] {
	if (directives.length === 0) return messages;

	// 找最后一个 assistant 消息的索引 G
	let lastAssistantIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			lastAssistantIdx = i;
			break;
		}
	}

	const result: TestMessage[] = [];
	const collected: CollectedDirective[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const content = msg.content ?? "";

		if (!DIRECTIVE_PLACEHOLDER_RE.test(content)) {
			DIRECTIVE_PLACEHOLDER_RE.lastIndex = 0;
			result.push(msg);
			continue;
		}
		DIRECTIVE_PLACEHOLDER_RE.lastIndex = 0;

		const found: CollectedDirective[] = [];
		const cleaned = content
			.replace(DIRECTIVE_PLACEHOLDER_RE, (_, idxStr) => {
				const d = directives[Number(idxStr)];
				if (d) found.push(d);
				return "";
			})
			.trim();

		if (cleaned) {
			result.push({ ...msg, content: cleaned });
		}

		// G 之后的 directive 收集到末尾；G 及之前的丢弃
		if (i > lastAssistantIdx) {
			collected.push(...found);
		}
	}

	// 末尾追加收集到的 directive
	for (const d of collected) {
		result.push({
			role: d.tag === "reminder" ? "latest_reminder" : "developer",
			content: d.content,
		});
	}

	return result;
}

// ── 辅助函数 ──

function pipeline(messages: DomainMessage[]): TestMessage[] {
	const adapter = new TestCollectingAdapter();
	const prompt = formatPrompt(messages, adapter);
	const raw = toTestMessages(prompt);
	return injectDirectives(raw, adapter.directives());
}

function messagesOfRole(msgs: TestMessage[], role: string): TestMessage[] {
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

		// G = assistant(回复1)，提示1 在 G 之前被 strip，提示2 在 G 之后收集到末尾
		const devMsgs = messagesOfRole(result, "developer");
		expect(devMsgs).toHaveLength(1);
		expect(devMsgs[0]!.content).toBe("提示2");

		// developer 在序列末尾
		const lastMsg = result[result.length - 1];
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

		// G = assistant(A2), H1 和 H2 在 G 之前被 strip，H3 在 G 之后收集到末尾
		const devMsgs = messagesOfRole(result, "developer");
		expect(devMsgs).toHaveLength(1);
		expect(devMsgs[0]!.content).toBe("H3");

		// developer 在序列末尾
		const lastMsg = result[result.length - 1];
		expect(lastMsg.role).toBe("developer");

		// H3 在 A2 之后
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

		// 不应有空 user 消息残留
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
			{ type: "user_input", content: "帮我安装包", context: null, hint: null },
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

		// diagnostic_hint 的 developer 消息应在 tool result 之后
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
		msgs: TestMessage[],
	): { ok: boolean; issue?: string } {
		for (let i = 0; i < msgs.length; i++) {
			const msg = msgs[i];
			if (
				msg.role === "assistant" &&
				msg.tool_calls &&
				msg.tool_calls.length > 0
			) {
				const n = msg.tool_calls.length;
				for (let j = 1; j <= n; j++) {
					const next = msgs[i + j];
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
					{ id: "tc_4", tool: "exec", args: { script: "git diff HEAD~3" } },
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

		// directive（output_hint）应存在但不在 tool 消息间
		const devMsgs = messagesOfRole(result, "developer");
		expect(devMsgs.length).toBeGreaterThanOrEqual(1);

		// 所有 developer 消息都在最后一个 tool 消息之后
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
			// 第一轮 tool_calls
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
				truncatedChunks: [{ startLine: 1, endLine: 199, tokens: 1500 }],
				durationMs: 100,
			} as DomainMessage,
			// 第二轮 tool_calls（最后一个 assistant = G）
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
				truncatedChunks: [{ startLine: 1, endLine: 149, tokens: 1200 }],
				durationMs: 90,
			} as DomainMessage,
		]);

		const integrity = checkToolCallIntegrity(result);
		expect(integrity.ok).toBe(true);

		// 只保留最后一轮（G 之后）的 directives
		const devMsgs = messagesOfRole(result, "developer");
		expect(devMsgs.length).toBeGreaterThanOrEqual(1);

		// 所有 developer 在序列末尾
		const lastNonDev = result.reduce(
			(acc, m, i) => (m.role !== "developer" ? i : acc),
			-1,
		);
		for (let i = 0; i < result.length; i++) {
			if (result[i].role === "developer") {
				expect(i).toBeGreaterThan(lastNonDev);
			}
		}
	});
});
