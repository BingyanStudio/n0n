/**
 * 构建 apps/code 场景的完整 LLM 请求数据，导出为 JSON。
 *
 * 复用项目模块真实构建：system prompt、tool definitions、messages。
 * 输出的 JSON 可供 render-chat-template.py 用 Jinja2 渲染为 Qwen 原始文本流。
 *
 * 用法：bun run scripts/build-code-request.ts [--user "你的任务描述"]
 */

import { formatPrompt } from "@n0n/shared";
import { makeToolkit } from "@n0n/tools";
import type { DomainMessage, ToolDefinition } from "@n0n/types";
import { resolve } from "node:path";

import codePromptText from "../apps/code/src/prompts/code.md" with { type: "text" };
import { CodeResultSchema } from "../apps/code/src/schema.ts";

// ── 参数 ──

const userArg = (() => {
	const idx = process.argv.indexOf("--user");
	if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
	return '帮我阅读当前项目的 README，然后总结项目的核心功能。';
})();

// ── 构建 system prompt（与 repl.ts 一致） ──

const workspace = process.cwd();

function buildEnvironmentSection(ws: string): string {
	return [
		"",
		"# Environment",
		"",
		`- Working directory: \`${ws}\``,
		"- All tool paths resolve relative to this directory:",
		"  - `exec` scripts run with cwd = working directory",
		"  - `write` / `edit` relative paths resolve against working directory",
		"",
		"Use relative paths (e.g. `src/utils.ts`) — they will resolve correctly.",
		"Read existing code before modifying it to understand project structure.",
	].join("\n");
}

let systemPrompt = codePromptText;

// 尝试加载 AGENTS.md
import { formatAgentsMdPrompt, loadAgentsMd } from "@n0n/shared";
const agentsMd = await loadAgentsMd(workspace);
if (agentsMd) {
	systemPrompt += `\n\n${formatAgentsMdPrompt(agentsMd)}`;
}
systemPrompt += buildEnvironmentSection(workspace);

// ── 构建 tool definitions ──

const modelId = "qwen3-235b-a22b";

const toolsConfig = {
	workspace,
	tempDir: resolve(workspace, ".temp"),
	security: { blockedCommands: [] as string[] },
	agent: { defaultExecTimeout: 120 },
	editorClient: null as any,
};

const toolkit = await makeToolkit(CodeResultSchema, toolsConfig, modelId);
const toolDefinitions: ToolDefinition[] = toolkit.tools;

// ── 构建 messages（模拟首轮请求） ──

// 模拟 gatherContext
function gatherContextSync(): string | null {
	const parts: string[] = [];
	try {
		const gitBranch = Bun.spawnSync(["git", "branch", "--show-current"], { cwd: workspace });
		const branch = gitBranch.stdout.toString().trim();
		if (branch) parts.push(`<git_branch>${branch}</git_branch>`);

		const gitStatus = Bun.spawnSync(["git", "status", "--short"], { cwd: workspace });
		const status = gitStatus.stdout.toString().trim();
		if (status) parts.push(`<git_status>\n${status}\n</git_status>`);
	} catch {}
	return parts.length > 0 ? parts.join("\n") : null;
}

const domainMessages: DomainMessage[] = [
	{ type: "system", content: systemPrompt },
	{
		type: "user_input",
		content: userArg!,
		context: gatherContextSync(),
		hint: null,
	},
];

// ── DomainMessage → PromptMessage → OpenAI 格式 ──

const promptMessages = formatPrompt(domainMessages, modelId);

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
