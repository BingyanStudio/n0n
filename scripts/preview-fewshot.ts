/**
 * preview-fewshot.ts — 预览 apps/code 完整的对话前缀
 *
 * 组装和真实运行时一致的消息序列：system prompt + fewshot 对话 + 工具定义 + 模拟用户输入，
 * 经 formatPrompt 渲染后输出为可读的 markdown，便于检查各部分是否有冲突和矛盾。
 *
 * 用法：
 *   bun run scripts/preview-fewshot.ts                           # 默认模型 + 默认用户消息
 *   bun run scripts/preview-fewshot.ts --model deepseek-chat     # 指定模型（影响 XML tag 风格）
 *   bun run scripts/preview-fewshot.ts --user "修复登录 bug"      # 自定义用户消息
 *   bun run scripts/preview-fewshot.ts --out .temp/preview.md    # 自定义输出路径
 */

import { resolve } from "node:path";
import { formatPrompt } from "@n0n/shared";
import { makeToolkit } from "@n0n/tools";
import type { DomainMessage, PromptMessage, ToolDefinition } from "@n0n/types";

import codePromptText from "../apps/code/src/prompts/code.md" with { type: "text" };
import { buildContextFewshot } from "../apps/code/src/context-fewshot.ts";
import { CodeResultSchema } from "../apps/code/src/schema.ts";

// ── CLI 参数 ──

function getArg(name: string, fallback: string): string {
	const idx = process.argv.indexOf(name);
	return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1]! : fallback;
}

const modelId = getArg("--model", "claude-sonnet-4-20250514");
const userMessage = getArg("--user", "项目里的 auth 模块最近频繁报 token 过期，帮我排查一下原因，如果能修就顺手修了。");
const outPath = resolve(getArg("--out", ".temp/preview-fewshot.md"));

// ── 组装 system prompt（与 repl.ts 一致） ──

const workspace = process.cwd();
const systemPrompt = codePromptText;

// ── 构建工具定义 ──

const toolsConfig = {
	workspace,
	tempDir: resolve(workspace, ".temp"),
	security: { blockedCommands: [] as string[] },
	agent: { defaultExecTimeout: 120 },
	editBackendType: "str-replace" as const,
	editorClient: { modelId: "", tagStyle: "default" as const, async *stream() { throw new Error("unused"); }, async complete() { throw new Error("unused"); } },
};

const toolkit = await makeToolkit(CodeResultSchema, toolsConfig, modelId);
const toolDefs: ToolDefinition[] = toolkit.tools;

// ── 组装完整 DomainMessage 序列（与 repl.ts 首轮一致） ──

const contextFewshot = await buildContextFewshot(toolkit, workspace, resolve(workspace, ".temp"));
const domainMessages: DomainMessage[] = [
	{ type: "system", content: systemPrompt },
	{ type: "cache_breakpoint" } as DomainMessage,
	...contextFewshot,
	{
		type: "user_input",
		content: userMessage,
		context: null,
		hint: null,
	},
];

// ── formatPrompt 渲染 ──

const promptMessages = formatPrompt(domainMessages, modelId);

// ── 输出为 markdown ──

function escapeForCodeBlock(s: string): string {
	// 如果内容中包含 ``` 则用 ~~~~ 作为围栏
	return s;
}

function toolCallSummary(msg: PromptMessage & { role: "assistant" }): string {
	if (!msg.toolCalls?.length) return "";
	return msg.toolCalls.map(tc => {
		const argsStr = JSON.stringify(tc.args, null, 2);
		const truncated = argsStr.length > 200 ? argsStr.slice(0, 200) + "\n  ..." : argsStr;
		return `  - **${tc.tool}** (id: ${tc.id})\n    \`\`\`json\n    ${truncated.replace(/\n/g, "\n    ")}\n    \`\`\``;
	}).join("\n");
}

const sections: string[] = [];

sections.push(`# Code Agent — 完整对话前缀预览`);
sections.push(`> Model: \`${modelId}\` | Generated: ${new Date().toISOString()}`);
sections.push("");

// 工具定义摘要
sections.push(`## Tool Definitions (${toolDefs.length} tools)`);
sections.push("");
for (const t of toolDefs) {
	const descPreview = t.description.slice(0, 120).replace(/\n/g, " ");
	const paramKeys = Object.keys(t.parameters.properties ?? {});
	sections.push(`- **${t.name}**(${paramKeys.join(", ")}): ${descPreview}...`);
}
sections.push("");

// Token 统计
let totalChars = 0;
const msgStats: { role: string; label: string; chars: number }[] = [];

for (let i = 0; i < promptMessages.length; i++) {
	const msg = promptMessages[i]!;
	let chars = msg.content.length;
	let label = "";

	if (msg.role === "tool") {
		label = `tool [${msg.toolName}]`;
	} else if (msg.role === "assistant" && "toolCalls" in msg && msg.toolCalls?.length) {
		label = `assistant → [${msg.toolCalls.map(tc => tc.tool).join(", ")}]`;
		chars += JSON.stringify(msg.toolCalls).length;
	} else {
		label = msg.role;
	}

	msgStats.push({ role: msg.role, label, chars });
	totalChars += chars;
}

sections.push(`## Message Sequence (${promptMessages.length} messages, ~${Math.round(totalChars / 4)} tokens)`);
sections.push("");
sections.push("| # | Role | Approx Tokens | Description |");
sections.push("|---|------|--------------|-------------|");
for (let i = 0; i < msgStats.length; i++) {
	const s = msgStats[i]!;
	sections.push(`| ${i + 1} | ${s.label} | ~${Math.round(s.chars / 4)} | ${s.chars.toLocaleString()} chars |`);
}
sections.push("");

// 分割线后逐条输出完整内容
sections.push("---");
sections.push("");

for (let i = 0; i < promptMessages.length; i++) {
	const msg = promptMessages[i]!;
	const stat = msgStats[i]!;

	sections.push(`## [${i + 1}/${promptMessages.length}] ${stat.label}`);
	sections.push("");

	if (msg.role === "assistant" && "toolCalls" in msg && msg.toolCalls?.length) {
		sections.push("**Tool Calls:**");
		sections.push(toolCallSummary(msg as any));
		sections.push("");
		if (msg.content) {
			sections.push("**Content:**");
		}
	}

	if (msg.role === "tool") {
		sections.push(`> tool_call_id: \`${msg.toolCallId}\`, tool: \`${msg.toolName}\``);
		sections.push("");
	}

	const content = msg.content;
	if (content) {
		const fence = content.includes("```") ? "~~~~" : "```";
		sections.push(`${fence}`);
		sections.push(content);
		sections.push(`${fence}`);
	}

	sections.push("");
}

// 写入文件
const output = sections.join("\n");
const dir = resolve(outPath, "..");
const { existsSync, mkdirSync } = await import("node:fs");
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
await Bun.write(outPath, output);

// 摘要统计
const toolDefChars = toolDefs.reduce((s, t) => s + t.description.length + JSON.stringify(t.parameters).length, 0);
const systemChars = systemPrompt.length;
const fewshotFormatted = formatPrompt(contextFewshot, modelId);
const fewshotChars = fewshotFormatted.reduce((s, m) => {
	let c = m.content.length;
	if (m.role === "assistant" && "toolCalls" in m && m.toolCalls) c += JSON.stringify(m.toolCalls).length;
	return s + c;
}, 0);

console.log(`Preview written to: ${outPath}`);
console.log("");
console.log("Token budget breakdown (approx):");
console.log(`  System prompt:    ~${Math.round(systemChars / 4).toLocaleString()} tokens (${systemChars.toLocaleString()} chars)`);
console.log(`  Tool definitions: ~${Math.round(toolDefChars / 4).toLocaleString()} tokens (${toolDefs.length} tools)`);
console.log(`  Fewshot examples: ~${Math.round(fewshotChars / 4).toLocaleString()} tokens (${contextFewshot.length} messages → ${fewshotFormatted.length} prompt messages)`);
console.log(`  User input:       ~${Math.round(userMessage.length / 4)} tokens`);
console.log(`  ────────────────────────────`);
console.log(`  Total prefix:     ~${Math.round(totalChars / 4).toLocaleString()} tokens (${totalChars.toLocaleString()} chars)`);
