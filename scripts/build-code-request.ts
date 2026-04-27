/**
 * 构建 apps/code 场景的完整 LLM 请求数据，导出为 JSON。
 *
 * 复用项目模块真实构建：system prompt、tool definitions、messages。
 * 输出的 JSON 可供 render-chat-template.py 用 Jinja2 渲染为 Qwen 原始文本流。
 *
 * 用法：bun run scripts/build-code-request.ts [--user "你的任务描述"]
 */

import { createTagAdapter, formatPrompt } from "@n0n/shared";
import { makeToolkit } from "@n0n/tools";
import type { DomainMessage, ToolDefinition } from "@n0n/types";
import { resolve } from "node:path";

import codePromptText from "../apps/code/src/prompts/code.md" with { type: "text" };
import { CodeResultSchema } from "../apps/code/src/schema.ts";
import { buildContextFewshot } from "../apps/code/src/context-fewshot.ts";

// ── 参数 ──

const userArg = (() => {
	const idx = process.argv.indexOf("--user");
	if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
	return '帮我阅读当前项目的 README，然后总结项目的核心功能。';
})();

// ── 构建 system prompt（与 repl.ts 一致） ──

const workspace = process.cwd();
const systemPrompt = codePromptText;

// ── 构建 tool definitions ──

const modelId = "qwen3-235b-a22b";

const toolsConfig = {
	workspace,
	tempDir: resolve(workspace, ".temp"),
	security: { blockedCommands: [] as string[] },
	agent: { defaultExecWaitfor: 120 },
	editBackendType: "str-replace" as const,
	editorClient: { modelId: "", tagStyle: "default" as const, tags: createTagAdapter("default"), async *stream() { throw new Error("unused"); }, async complete() { throw new Error("unused"); }, async ping() { return { ok: true as const }; } },
};

const toolkit = await makeToolkit(CodeResultSchema, toolsConfig, modelId);
const toolDefinitions: ToolDefinition[] = toolkit.tools;

// ── 构建 messages（模拟首轮请求） ──

const domainMessages: DomainMessage[] = [
	{ type: "system", content: systemPrompt },
	{ type: "cache_breakpoint" } as DomainMessage,
	...(await buildContextFewshot(toolkit, workspace, resolve(workspace, ".temp"))),
	{
		type: "user_input",
		content: userArg!,
		context: null,
		hint: null,
	},
];

// ── DomainMessage → PromptMessage → OpenAI 格式 ──

const promptMessages = formatPrompt(domainMessages, createTagAdapter("default"));

// 转为 OpenAI 消息格式（与 openai-client.ts 中 toOpenAIMessages 一致）
interface OpenAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	reasoning_content?: string | null;
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
}

function toOpenAIMessages(msgs: typeof promptMessages): OpenAIMessage[] {
	const result: OpenAIMessage[] = [];
	for (const msg of msgs) {
		switch (msg.role) {
			case "system":
				result.push({ role: "system", content: msg.content });
				break;
			case "user":
				result.push({ role: "user", content: msg.content });
				break;
			case "assistant": {
				if (msg.toolCalls?.length) {
					result.push({
						role: "assistant",
						content: msg.content || null,
						reasoning_content: msg.reasoning ?? undefined,
						tool_calls: msg.toolCalls.map((tc) => ({
							id: tc.id,
							type: "function" as const,
							function: { name: tc.tool, arguments: JSON.stringify(tc.args) },
						})),
					});
				} else {
					result.push({
						role: "assistant",
						content: msg.content || null,
						reasoning_content: msg.reasoning ?? undefined,
					});
				}
				break;
			}
			case "tool":
				result.push({
					role: "tool",
					content: msg.content,
					tool_call_id: msg.toolCallId,
				});
				break;
		}
	}
	return result;
}

function toOpenAITools(tools: ToolDefinition[]) {
	return tools.map((t) => ({
		type: "function" as const,
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		},
	}));
}

const openaiMessages = toOpenAIMessages(promptMessages);
const openaiTools = toOpenAITools(toolDefinitions);

// ── 输出 ──

const output = {
	messages: openaiMessages,
	tools: openaiTools,
	add_generation_prompt: true,
	enable_thinking: true,
};

const outPath = resolve(workspace, ".temp/code-request.json");
await Bun.write(outPath, JSON.stringify(output, null, 2));
console.log(`Request JSON written to: ${outPath}`);
console.log(`  messages: ${openaiMessages.length}`);
console.log(`  tools: ${openaiTools.length}`);
