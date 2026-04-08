/**
 * fewshot — 预填充对话示例
 *
 * 构造一组真实格式的 DomainMessage，注入到对话历史的 system 消息之后、
 * 用户首条消息之前。模型看到"自己曾经"正确使用工具的记录，
 * 在后续交互中会自然复现这些模式。
 *
 * 每个教学场景由 <system-reminder> 包裹的情景设定 + 模拟的用户请求组成，
 * assistant 展示正确的工具调用方式，收到结果后进入下一个场景。
 *
 * 设计原则：
 * - 示例内容足够通用（不涉及真实项目文件），避免模型与后续任务混淆
 * - <system-reminder> 块明确标记教学边界，模型不会回复该块的内容
 * - 复用现有 DomainMessage 类型，不引入新的消息结构
 */

import type { DomainMessage } from "@n0n/types";

// ── 场景 1: 并行调用多个工具 ──

function scenario1_parallelCalls(): DomainMessage[] {
	return [
		{
			type: "user_text",
			content: [
				"<system-reminder>",
				"Below is a practice scenario. Demonstrate the correct tool-calling pattern, then move on.",
				"",
				"Scenario: The user asks you to do three independent things at once.",
				"Key point: issue all tool calls in a single response — write and edit are deterministic and never need to be awaited.",
				"</system-reminder>",
				"",
				"Create a hello.ts file, fix the typo in config.ts, and run the tests.",
			].join("\n"),
		},
		{
			type: "assistant_tool_call",
			content: "I'll handle all three at once.",
			reasoning: null,
			reasoningSignature: null,
			toolCalls: [
				{
					id: "fs_1",
					tool: "write" as const,
					args: {
						path: "hello.ts",
						content:
							'export function hello() {\n  return "Hello, world!";\n}\n',
					},
				},
				{
					id: "fs_2",
					tool: "edit" as const,
					args: {
						path: "config.ts",
						intent: "Fix the typo: change 'treu' to 'true'",
					},
				},
				{
					id: "fs_3",
					tool: "exec" as const,
					args: { script: "bun test", runtime: "cmd" },
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
					path: "hello.ts",
					content:
						'export function hello() {\n  return "Hello, world!";\n}\n',
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
					path: "config.ts",
					intent: "Fix the typo: change 'treu' to 'true'",
				},
			},
			diff: {
				chunks: [
					{
						startLine: 3,
						endLine: 3,
						lines: [
							{ line: 3, content: "  enabled: true,", changed: true },
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
				args: { script: "bun test", runtime: "cmd" },
			},
			status: "completed" as const,
			exitCode: 0,
			stdout: "bun test v1.0\n3 tests passed",
			stderr: "",
			durationMs: 450,
		} satisfies DomainMessage,
		{
			type: "assistant_text",
			content:
				"All done. Created hello.ts, fixed the typo in config.ts, and all 3 tests pass.",
		},
	];
}

// ── 场景 2: 用脚本替代多次 shell 调用 ──

function scenario2_scriptOverShell(): DomainMessage[] {
	return [
		{
			type: "user_text",
			content: [
				"<system-reminder>",
				"Scenario: The user asks for project analysis that would require reading many files.",
				"Key point: write one script that does all the processing internally, instead of issuing many separate shell commands.",
				"</system-reminder>",
				"",
				"Count the lines in each source file and show me the top 5 largest.",
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
							"console.log(`Total: ${files.length} files`);",
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
				args: {
					runtime: "bun",
					script: "...", // abbreviated in call record
				},
			},
			status: "completed" as const,
			exitCode: 0,
			stdout: "Total: 42 files\n  310 src/index.ts\n  285 src/utils.ts\n  201 src/parser.ts\n  178 src/config.ts\n  145 src/types.ts",
			stderr: "",
			durationMs: 120,
		} satisfies DomainMessage,
		{
			type: "assistant_text",
			content:
				"The project has 42 source files. The largest five are src/index.ts (310 lines), src/utils.ts (285), src/parser.ts (201), src/config.ts (178), and src/types.ts (145).",
		},
	];
}

// ── 组合 ──

/**
 * 生成全部 fewshot 教学对话。
 *
 * 返回值插入到 system 消息之后、真实用户输入之前。
 * 最后一条消息后，紧跟真实 user_input，作为教学结束的天然边界。
 */
export function buildFewshotMessages(): DomainMessage[] {
	return [...scenario1_parallelCalls(), ...scenario2_scriptOverShell()];
}
