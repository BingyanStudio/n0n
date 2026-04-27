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

	const result: TestMessage[] = [];

	for (const msg of messages) {
		const content = msg.content ?? "";
		const found: CollectedDirective[] = [];
		const cleaned = content
			.replace(DIRECTIVE_PLACEHOLDER_RE, (_, idxStr) => {
				const d = directives[Number(idxStr)];
				if (d) found.push(d);
				return "";
			})
			.trim();

		if (found.length === 0) {
			result.push(msg);
			continue;
		}

		if (cleaned) {
			result.push({ ...msg, content: cleaned });
		}
		for (const d of found) {
			result.push({
				role: d.tag === "reminder" ? "latest_reminder" : "developer",
				content: d.content,
			});
		}
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

	it("多轮 user_input 各自带 hint：每个 hint 应与其 user 消息对齐", () => {
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
		expect(devMsgs).toHaveLength(2);
		expect(devMsgs[0]!.content).toBe("提示1");
		expect(devMsgs[1]!.content).toBe("提示2");

		const contents = result.map((m) => m.content);
		const hint2Idx = contents.indexOf("提示2");
		const reply1Idx = contents.indexOf("回复1");
		const question2Idx = contents.indexOf("问题2");

		// 关键：提示2 在 回复1 之后
		expect(hint2Idx).toBeGreaterThan(reply1Idx);
		// 提示2 紧跟 问题2
		expect(hint2Idx).toBe(question2Idx + 1);
	});

	it("三轮对话：每轮 hint 不错位", () => {
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
		expect(devMsgs).toHaveLength(3);
		expect(devMsgs[0]!.content).toBe("H1");
		expect(devMsgs[1]!.content).toBe("H2");
		expect(devMsgs[2]!.content).toBe("H3");

		const contents = result.map((m) => m.content);
		expect(contents.indexOf("H2")).toBeGreaterThan(contents.indexOf("A1"));
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
