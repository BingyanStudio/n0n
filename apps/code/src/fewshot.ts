/**
 * fewshot — 预填充对话示例
 *
 * 构造一组真实格式的 DomainMessage，注入到对话历史的 system 消息之后、
 * 用户首条消息之前。模型会看到"自己曾经"一次性并行调用多个工具的记录，
 * 从而更倾向于在后续交互中复现这种并行模式。
 *
 * 设计原则：
 * - 示例内容足够通用（不涉及具体项目文件），避免模型与真实任务混淆
 * - 尽量精简，控制 token 消耗
 * - 复用现有 DomainMessage 类型，不引入新的消息结构
 */

import type { DomainMessage } from "@n0n/types";

/**
 * 生成 fewshot 对话示例。
 *
 * 展示一个完整的交互回合：用户提出多步任务，assistant 在单次响应中
 * 并行发出 write + edit + exec 三个工具调用，然后收到三个结果。
 *
 * 调用方将这些消息插入到 system 消息之后、真实用户输入之前。
 */
export function buildFewshotMessages(): DomainMessage[] {
	return [
		// ── 虚拟用户请求 ──
		{
			type: "user_text",
			content:
				"Create a hello.ts file, fix the typo in config.ts, and run the tests.",
		},

		// ── assistant 一次性发出三个并行调用 ──
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
					args: {
						script: "bun test",
						runtime: "cmd",
					},
				},
			],
		},

		// ── 三个工具结果 ──
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
				args: {
					script: "bun test",
					runtime: "cmd",
				},
			},
			status: "completed" as const,
			exitCode: 0,
			stdout: "bun test v1.0\n3 tests passed",
			stderr: "",
			durationMs: 450,
		} satisfies DomainMessage,

		// ── assistant 看到结果后作出总结 ──
		{
			type: "assistant_text",
			content:
				"All done. Created hello.ts, fixed the typo in config.ts, and all 3 tests pass.",
		},
	];
}
