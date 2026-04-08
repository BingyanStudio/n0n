/**
 * fewshot — 预填充对话示例
 *
 * 构造真实格式的 DomainMessage 序列，注入到 system 消息之后、
 * 用户首条消息之前。模型看到"自己曾经"正确使用工具的完整记录，
 * 在后续交互中会自然复现这些模式。
 *
 * 每个教学场景：
 * 1. <system-reminder> 设定虚构的项目背景（文件结构、git 状态等）
 * 2. 一个贴近真实的用户请求（不是直白的指令，而是需要 agent 判断的任务描述）
 * 3. assistant 展示正确的工具调用模式
 * 4. 以 submit 结束（遵守真实流程）
 *
 * 设计原则：
 * - 场景要有足够的上下文（虚构的项目状态），让模型学到"在什么条件下做什么"
 * - 用户请求贴近真实（模糊、间接），而非直白的操作指令
 * - 所有回合以 submit 结束，不用纯文本回复
 * - 复用现有 DomainMessage 类型，不引入新结构
 */

import type { DomainMessage } from "@n0n/types";
// submit 在 schema 模式下 args 直接是 CodeResult 的字段（非 SubmitArgs），
// 类型系统无法表达这种运行时多态，用 Record<string, unknown> 绕过。
type SubmitCallArgs = Record<string, unknown>;

/** 构造 submit 工具调用 + 结果的消息对 */
function submitPair(
	id: string,
	args: SubmitCallArgs,
): [DomainMessage, DomainMessage] {
	const call = { id, tool: "submit" as const, args: args as any };
	return [
		{
			type: "assistant_tool_call",
			content: null,
			reasoning: null,
			reasoningSignature: null,
			toolCalls: [call],
		},
		{
			type: "tool_result",
			tool: "submit" as const,
			call,
			cleanedResult: args,
			userResponse: undefined,
		} as DomainMessage,
	];
}

// ── 场景 1: 并行调用多个工具 ──
// 教学重点: write/edit 是确定性工具，不需要等待结果，一次性发出所有调用

function scenario1_parallelCalls(): DomainMessage[] {
	return [
		{
			type: "user_text",
			content: [
				"<system-reminder>",
				"Below is a practice scenario. Demonstrate the correct tool-calling pattern, then submit the result.",
				"",
				"Project context:",
				"- TypeScript project with bun runtime",
				"- src/config.ts has a typo on line 12: `enabled: treu` should be `enabled: true`",
				"- src/utils/ directory exists but has no index.ts barrel file yet",
				"- Tests are in src/__tests__/, runnable with `bun test`",
				"",
				"Scenario: The user reports a bug and asks for a quick fix. The task involves creating a file, editing another, and verifying — all independent of each other.",
				"Key point: issue all independent tool calls in a single response. write and edit are deterministic — do not wait for their results.",
				"</system-reminder>",
				"",
				"config.ts 里有个拼写错误导致测试挂了，顺便帮我给 utils 加个 barrel file。",
			].join("\n"),
		},
		{
			type: "assistant_tool_call",
			content: null,
			reasoning: null,
			reasoningSignature: null,
			toolCalls: [
				{
					id: "fs_1",
					tool: "write" as const,
					args: {
						path: "src/utils/index.ts",
						content: [
							'export { formatDate } from "./format-date.ts";',
							'export { parseConfig } from "./parse-config.ts";',
							"",
						].join("\n"),
					},
				},
				{
					id: "fs_2",
					tool: "edit" as const,
					args: {
						path: "src/config.ts",
						intent:
							"Fix typo on line 12: change `enabled: treu` to `enabled: true`",
					},
				},
				{
					id: "fs_3",
					tool: "exec" as const,
					args: { script: "bun test" },
				},
			],
		},
		{
			type: "tool_result",
			tool: "write" as const,
			call: {
				id: "fs_1",
				tool: "write" as const,
				args: {
					path: "src/utils/index.ts",
					content: [
						'export { formatDate } from "./format-date.ts";',
						'export { parseConfig } from "./parse-config.ts";',
						"",
					].join("\n"),
				},
			},
			status: "completed" as const,
		} satisfies DomainMessage,
		{
			type: "tool_result",
			tool: "edit" as const,
			call: {
				id: "fs_2",
				tool: "edit" as const,
				args: {
					path: "src/config.ts",
					intent:
						"Fix typo on line 12: change `enabled: treu` to `enabled: true`",
				},
			},
			diff: {
				chunks: [
					{
						startLine: 12,
						endLine: 12,
						lines: [
							{ line: 12, content: "  enabled: true,", changed: true },
						],
					},
				],
				added: 1,
				removed: 1,
			},
			success: true,
			error: null,
			feedback: null,
			rounds: 1,
			durationMs: 1200,
		} satisfies DomainMessage,
		{
			type: "tool_result",
			tool: "exec" as const,
			call: {
				id: "fs_3",
				tool: "exec" as const,
				args: { script: "bun test" },
			},
			status: "completed" as const,
			exitCode: 0,
			stdout: "bun test v1.2\n  src/__tests__/config.test.ts:\n    (pass) loads default config [2.1ms]\n    (pass) validates required fields [0.8ms]\n  2 pass | 0 fail",
			stderr: "",
			durationMs: 340,
		} satisfies DomainMessage,
		...submitPair("fs_s1", {
			type: "completed",
			summary: "修复了 src/config.ts 第 12 行的拼写错误（treu → true），创建了 src/utils/index.ts barrel file 导出现有模块。测试全部通过。",
		}),
	];
}

// ── 场景 2: 用脚本替代多次 shell 调用 ──
// 教学重点: 数据处理任务用一个脚本内聚完成，不要逐条发 shell 命令

function scenario2_scriptOverShell(): DomainMessage[] {
	return [
		{
			type: "user_text",
			content: [
				"<system-reminder>",
				"Project context:",
				"- Monorepo with packages/ and apps/ directories, ~80 TypeScript source files",
				"- No existing analysis scripts",
				"",
				"Scenario: The user wants to understand the codebase structure before starting work.",
				"Key point: write one script that processes and summarizes data internally, instead of chaining many shell commands. Output should be pre-processed — do not dump raw output into context.",
				"</system-reminder>",
				"",
				"我刚接手这个项目，能帮我看看代码规模和结构吗？哪些文件比较大需要关注？",
			].join("\n"),
		},
		{
			type: "assistant_tool_call",
			content: null,
			reasoning: null,
			reasoningSignature: null,
			toolCalls: [
				{
					id: "fs_4",
					tool: "exec" as const,
					args: {
						runtime: "bun",
						script: [
							"import { readdir, readFile } from 'node:fs/promises';",
							"import { join } from 'node:path';",
							"const files = [];",
							"async function walk(dir) {",
							"  for (const e of await readdir(dir, { withFileTypes: true })) {",
							"    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;",
							"    const full = join(dir, e.name);",
							"    if (e.isDirectory()) await walk(full);",
							"    else if (e.name.match(/\\.(ts|js)$/)) {",
							"      const c = await readFile(full, 'utf8');",
							"      files.push({ path: full, lines: c.split('\\n').length });",
							"    }",
							"  }",
							"}",
							"await walk('.');",
							"files.sort((a, b) => b.lines - a.lines);",
							"console.log(`Total: ${files.length} files, ${files.reduce((s,f) => s + f.lines, 0)} lines`);",
							"console.log('Top 5:');",
							"for (const f of files.slice(0, 5)) console.log(`  ${f.lines} ${f.path}`);",
						].join("\n"),
					},
				},
			],
		},
		{
			type: "tool_result",
			tool: "exec" as const,
			call: {
				id: "fs_4",
				tool: "exec" as const,
				args: { runtime: "bun", script: "..." },
			},
			status: "completed" as const,
			exitCode: 0,
			stdout: "Total: 83 files, 12,450 lines\nTop 5:\n  310 packages/core/src/agent/loop.ts\n  285 packages/shared/src/format-prompt.ts\n  201 packages/tools/src/exec/executor.ts\n  178 apps/code/src/repl.ts\n  145 packages/types/src/domain.ts",
			stderr: "",
			durationMs: 120,
		} satisfies DomainMessage,
		...submitPair("fs_s2", {
			type: "completed",
			summary: "项目共 83 个源文件，合计 12,450 行。最大的五个文件是 loop.ts（310 行）、format-prompt.ts（285 行）、executor.ts（201 行）、repl.ts（178 行）、domain.ts（145 行）。建议优先熟悉 loop.ts 和 format-prompt.ts，它们是核心编排和消息格式化逻辑所在。",
			next_step: "如果需要更细粒度的分析（函数级别、依赖关系图），可以用 ts-morph 做进一步扫描。",
		}),
	];
}

// ── 组合 ──

/**
 * 生成全部 fewshot 教学对话。
 *
 * 返回值插入到 system 消息之后、真实用户输入之前。
 * 最后一条 submit result 之后紧跟真实 user_input，天然标志教学结束。
 */
export function buildFewshotMessages(): DomainMessage[] {
	return [...scenario1_parallelCalls(), ...scenario2_scriptOverShell()];
}
