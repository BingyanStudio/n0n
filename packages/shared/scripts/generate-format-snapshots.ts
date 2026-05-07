/**
 * format-prompt snapshot 生成器
 *
 * 为每种 DomainMessage 类型生成独立的 snapshot 文件，
 * 展示 formatPrompt 的格式化结果，供人工检查提示词结构。
 *
 * 运行: bun run packages/shared/scripts/generate-format-snapshots.ts
 * 输出: packages/shared/scripts/preview-output/<type>.snapshot.md
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DomainMessage, PromptMessage } from "@n0n/types";
import { formatPrompt } from "../src/format-prompt/index.ts";

const MODEL = "claude-sonnet-4-20250514";
const SNAPSHOT_DIR = join(import.meta.dir, "preview-output");

mkdirSync(SNAPSHOT_DIR, { recursive: true });

/** 单个 snapshot 场景 */
interface Scenario {
	/** 文件名（不含扩展名） */
	file: string;
	/** 场景标题 */
	title: string;
	/** 输入的 DomainMessage 列表 */
	messages: DomainMessage[];
}

const scenarios: Scenario[] = [
	// ── system ──
	{
		file: "system",
		title: "system 消息 + 连续合并",
		messages: [
			{ type: "system", content: "You are a helpful assistant." },
			{ type: "system", content: "Always use tools to make progress." },
		],
	},

	// ── user ──
	{
		file: "user-text",
		title: "user_text 消息",
		messages: [{ type: "generic_user_text", content: "Hello, help me fix this bug." }],
	},
	{
		file: "user-input",
		title: "user_input 消息（含 context + hint）",
		messages: [
			{
				type: "user_input",
				content: "Fix the bug in auth module",
				context:
					"<git_branch>main</git_branch>\n<git_status>M src/auth.ts</git_status>",
				hint: "Start by reading src/auth.ts",
			},
		],
	},
	{
		file: "user-image",
		title: "user_image 消息（降级为文本）",
		messages: [
			{
				type: "user_image",
				text: "What is this error?",
				imagePath: "/tmp/screenshot.png",
				focusX: 0,
				focusY: 0,
				scale: 1,
			},
		],
	},

	// ── assistant ──
	{
		file: "assistant-text",
		title: "assistant_text 消息（含 reasoning）",
		messages: [
			{
				type: "assistant_text",
				content: "I'll help you fix that bug.",
				reasoning:
					"The user wants me to fix an auth bug. Let me read the file first.",
				reasoningSignature: "sig_abc123",
			},
		],
	},
	{
		file: "assistant-tool-call",
		title: "assistant_tool_call 消息",
		messages: [
			{
				type: "assistant_tool_call",
				content: "Let me read the file.",
				reasoning: null,
				reasoningSignature: null,
				toolCalls: [
					{ id: "tc_1", tool: "exec", args: { script: "cat src/auth.ts" } },
					{
						id: "tc_2",
						tool: "write",
						args: { path: "test.txt", content: "hi" },
					},
				],
			},
		],
	},

	// ── exec tool_result (3 statuses) ──
	{
		file: "exec-completed",
		title: "exec tool_result — status: completed（正常完成）",
		messages: [
			{
				type: "tool_result",
				tool: "exec",
				status: "completed",
				call: {
					id: "tc_1",
					tool: "exec",
					args: { script: "echo hello && ls", runtime: "sh", cwd: "src" },
				},
				exitCode: 0,
				stdout: "hello\nindex.ts\nutils.ts",
				stderr: "",
				durationMs: 12,
			},
		],
	},
	{
		file: "exec-completed-error",
		title: "exec tool_result — status: completed（命令失败）",
		messages: [
			{
				type: "tool_result",
				tool: "exec",
				status: "completed",
				call: { id: "tc_2", tool: "exec", args: { script: "cat missing.txt" } },
				exitCode: 1,
				stdout: "",
				stderr: "cat: missing.txt: No such file or directory",
				durationMs: 5,
			},
		],
	},
	{
		file: "exec-truncated",
		title: "exec tool_result — status: truncated（输出超长截断）",
		messages: [
			{
				type: "tool_result",
				tool: "exec",
				status: "truncated",
				call: {
					id: "tc_3",
					tool: "exec",
					args: { script: "find . -name '*.ts'", runtime: "sh" },
				},
				exitCode: 0,
				stdoutTail:
					"./src/exec/executor.ts\n./src/exec/security.ts\n./src/types/domain.ts",
				stderrTail: "",
				outputFile: ".temp/exec_output_tc_3.txt",
				stdoutLength: 28450,
				stderrLength: 0,
				totalLines: 850,
				tailStartLine: 847,
				truncatedChunks: [],
				durationMs: 320,
			},
		],
	},
	{
		file: "exec-timed-out",
		title: "exec tool_result — status: backgrounded（等待超限转后台）",
		messages: [
			{
				type: "tool_result",
				tool: "exec",
				status: "backgrounded",
				call: {
					id: "tc_4",
					tool: "exec",
					args: { script: "npm install", waitfor: 30 },
				},
				pid: 65432,
				logFile: ".temp/exec_bg_65432.log",
				stdoutSoFar:
					"npm warn deprecated inflight@1.0.6\nadded 142 packages in 28s",
				stderrSoFar: "",
				durationMs: 30003,
			},
		],
	},

	// ── other tool_results ──
	{
		file: "write-result",
		title: "write tool_result",
		messages: [
			{
				type: "tool_result",
				tool: "write",
				call: {
					id: "tc_5",
					tool: "write",
					args: { path: "src/config.ts", content: "export const x = 1;" },
				},
				status: "completed",
			},
		],
	},
	{
		file: "edit-result",
		title: "edit tool_result",
		messages: [
			{
				type: "tool_result",
				tool: "edit",
				call: {
					id: "tc_6",
					tool: "edit",
					args: { path: "src/auth.ts", intent: "fix the null check" },
				},
				success: true,
				patches: [
					{
						oldText: "  const user = getUser();\n  return user.name;",
						newText: "  const user = getUser();\n  if (!user) return null;\n  return user.name;",
					},
				],
				error: null,
				feedback: null,
				rounds: 1,
				durationMs: 2500,
			},
		],
	},
	// ── special messages ──
	{
		file: "idle-nudge",
		title: "idle_nudge 消息",
		messages: [{ type: "idle_nudge", idleCount: 2, maxIdleRounds: 5 }],
	},
	{
		file: "progress-result",
		title: "progress tool_result",
		messages: [
			{
				type: "tool_result",
				tool: "progress",
				call: {
					id: "tc_7",
					tool: "progress",
					args: { status: "completed", content: "Task done" },
				},
				cleanedResult: { status: "completed", content: "Task done" },
			},
		],
	},
	{
		file: "tool-arg-error",
		title: "tool_arg_error 消息（含 schema）",
		messages: [
			{
				type: "tool_arg_error",
				callId: "tc_err",
				tool: "exec",
				error: "script: Required",
				schema: {
					type: "object",
					properties: { script: { type: "string" } },
					required: ["script"],
				},
			},
		],
	},
];

// ── 生成 ──

function formatResult(r: PromptMessage): string {
	const lines = [`role: ${r.role}`];
	if (r.role === "tool") {
		lines.push(`toolCallId: ${r.toolCallId}`);
		lines.push(`toolName: ${r.toolName}`);
	}
	if (r.role === "assistant" && r.reasoning) {
		lines.push(`reasoning: ${r.reasoning}`);
	}
	if (r.role === "assistant" && r.toolCalls?.length) {
		lines.push(`toolCalls: ${JSON.stringify(r.toolCalls, null, 2)}`);
	}
	lines.push("", "--- content ---", r.content);
	return lines.join("\n");
}

let count = 0;
for (const scenario of scenarios) {
	const results = formatPrompt(scenario.messages, MODEL);
	const parts = [`# ${scenario.title}`, `<!-- model: ${MODEL} -->`, ""];
	for (const r of results) {
		parts.push("```", formatResult(r), "```", "");
	}
	const outPath = join(SNAPSHOT_DIR, `${scenario.file}.snapshot.md`);
	await Bun.write(outPath, parts.join("\n"));
	count++;
}

console.log(`Generated ${count} snapshots in ${SNAPSHOT_DIR}/`);
