/**
 * 实验：切换 thinking 模式对 Anthropic prompt caching 的影响
 *
 * 背景：用户观察到关闭思考模式后，历史消息中的 thinking block 被抛弃。
 * 文档声称：
 *   - thinking 参数变化会 invalidate message cache breakpoints
 *   - system prompts 和 tools 在 thinking 参数变化时仍保持 cached
 *   - 被 disabled 的 thinking 请求中如果传了 thinking content，API 会 strip 它们
 *
 * 实验矩阵：
 *   A. baseline：两次 thinking=true，相同消息 → 验证 cache hit
 *   B. 切换模式 + 保留 thinking blocks：第一次 thinking=true，第二次 thinking=false
 *      但历史消息中保留 thinking block → 观察 message cache 是否 miss
 *   C. 切换模式 + 剥离 thinking blocks：第一次 thinking=true，第二次 thinking=false
 *      且手动剥离历史中的 thinking block → 观察 message cache 行为
 *   D. 仅 system+tools cache：切换 thinking 参数，观察 system/tools 级 cache 是否存活
 *
 * 用法: bun run scripts/experiment-thinking-cache.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── 加载 .env ──
const envPath = resolve("C:/Users/29659/.n0n/.env");
const envContent = readFileSync(envPath, "utf8");
for (const line of envContent.split("\n")) {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#")) continue;
	const eqIdx = trimmed.indexOf("=");
	if (eqIdx < 0) continue;
	const key = trimmed.slice(0, eqIdx).trim();
	const val = trimmed.slice(eqIdx + 1).trim();
	if (!process.env[key]) process.env[key] = val;
}

const API_KEY = process.env.LLM_API_KEY ?? "";
const BASE_URL = (process.env.LLM_BASE_URL ?? "https://api.anthropic.com")
	.replace(/\/v1\/?$/, "")
	.replace(/\/$/, "");
const API_URL = `${BASE_URL}/v1/messages`;
const MODEL = process.env.LLM_MODEL ?? "claude-opus-4-6";

console.log(`API URL: ${API_URL}`);
console.log(`Model: ${MODEL}`);
console.log("");

// ── 长 system prompt（确保超过 1024 tokens 以触发缓存） ──
const SYSTEM_PROMPT = [
	"You are an expert software engineer assistant.",
	"You help with code reviews, debugging, and architecture decisions.",
	...Array.from(
		{ length: 200 },
		(_, i) =>
			`Guideline ${i + 1}: When writing code, always consider edge cases, error handling, performance implications, and maintainability. ` +
			`Use descriptive variable names, write comprehensive tests, and document your reasoning carefully. ` +
			`Follow established patterns, maintain backward compatibility, and consider migration paths for any breaking changes.`,
	),
	"Always respond concisely and accurately.",
].join("\n\n");

// ── 工具定义（用于验证 tools cache） ──
const TOOLS = [
	{
		name: "exec",
		description:
			"Execute a script on the system. Supports cmd, pwsh, bun, node, uv runtimes.",
		input_schema: {
			type: "object",
			properties: {
				script: { type: "string", description: "Script content to execute" },
				runtime: {
					type: "string",
					enum: ["cmd", "pwsh", "bun", "node", "uv"],
					description: "Runtime to use",
				},
				timeout: {
					type: "number",
					description: "Timeout in seconds (default: 120)",
				},
			},
			required: ["script"],
		},
	},
	{
		name: "write",
		description: "Create or overwrite a file with the given content.",
		input_schema: {
			type: "object",
			properties: {
				path: { type: "string", description: "File path" },
				content: { type: "string", description: "File content" },
			},
			required: ["path", "content"],
		},
	},
];

// ── API 请求封装 ──

interface UsageInfo {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
}

interface RequestResult {
	usage: UsageInfo;
	content: Array<{ type: string; text?: string; thinking?: string; signature?: string; id?: string; name?: string }>;
	stop_reason: string;
}

async function sendRequest(options: {
	system: string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
	messages: Array<Record<string, unknown>>;
	thinking?: { type: "enabled"; budget_tokens: number };
	tools?: typeof TOOLS;
	maxTokens?: number;
	cacheControl?: { type: "ephemeral" };
}): Promise<RequestResult> {
	const body: Record<string, unknown> = {
		model: MODEL,
		max_tokens: options.maxTokens ?? 256,
		system: options.system,
		messages: options.messages,
		stream: false,
	};

	if (options.tools?.length) {
		body.tools = options.tools;
		body.tool_choice = { type: "auto" };
	}
	if (options.thinking) {
		body.thinking = options.thinking;
		body.max_tokens = (options.thinking.budget_tokens ?? 1024) + 256;
		body.temperature = 1;
	}
	if (options.cacheControl) {
		body.cache_control = options.cacheControl;
	}

	const res = await fetch(API_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": API_KEY,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(60_000),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`API ${res.status}: ${text}`);
	}

	const json = (await res.json()) as {
		usage: UsageInfo;
		content: RequestResult["content"];
		stop_reason: string;
	};
	return json;
}

function printUsage(label: string, usage: UsageInfo) {
	console.log(`  [${label}]`);
	console.log(`    input_tokens:                 ${usage.input_tokens}`);
	console.log(`    output_tokens:                ${usage.output_tokens}`);
	console.log(
		`    cache_creation_input_tokens:  ${usage.cache_creation_input_tokens ?? "N/A"}`,
	);
	console.log(
		`    cache_read_input_tokens:      ${usage.cache_read_input_tokens ?? "N/A"}`,
	);
	console.log("");
}

function delay(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

// ── 实验 A：baseline，两次 thinking=true ──
async function experimentA() {
	console.log("═".repeat(70));
	console.log("实验 A：Baseline — 连续两次 thinking=true，相同消息");
	console.log("预期：第二次有 cache_read_input_tokens > 0");
	console.log("═".repeat(70));

	const systemBlocks = [
		{ type: "text" as const, text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } },
	];
	const messages = [
		{ role: "user", content: "What is 2+2? Answer briefly." },
	];
	const thinking = { type: "enabled" as const, budget_tokens: 1024 };

	console.log("\n  请求 1 (thinking=true, cache write)...");
	const r1 = await sendRequest({
		system: systemBlocks,
		messages,
		thinking,
		tools: TOOLS,
	});
	printUsage("R1", r1.usage);

	await delay(3000);

	console.log("  请求 2 (thinking=true, 同参数 → 期望 cache hit)...");
	const r2 = await sendRequest({
		system: systemBlocks,
		messages,
		thinking,
		tools: TOOLS,
	});
	printUsage("R2", r2.usage);

	console.log(
		`  结论：cache_read R1=${r1.usage.cache_read_input_tokens ?? 0} → R2=${r2.usage.cache_read_input_tokens ?? 0}`,
	);
	console.log("");
}

// ── 实验 B：切换模式，保留 thinking blocks ──
async function experimentB() {
	console.log("═".repeat(70));
	console.log("实验 B：切换 thinking=true → false，保留历史 thinking blocks");
	console.log("预期：message cache miss，但 system+tools cache 可能 hit");
	console.log("═".repeat(70));

	const systemBlocks = [
		{ type: "text" as const, text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } },
	];
	const userMsg = { role: "user", content: "What is 2+2? Answer briefly." };

	// 第 1 步：thinking=true 发送请求
	console.log("\n  请求 1 (thinking=true, 建立 cache)...");
	const r1 = await sendRequest({
		system: systemBlocks,
		messages: [userMsg],
		thinking: { type: "enabled", budget_tokens: 1024 },
		tools: TOOLS,
	});
	printUsage("R1 (thinking=true)", r1.usage);

	// 提取 assistant 回复中的 thinking block + text block
	const thinkingBlock = r1.content.find((b) => b.type === "thinking");
	const textBlock = r1.content.find((b) => b.type === "text");

	console.log(`  R1 回复含: ${r1.content.map((b) => b.type).join(", ")}`);
	if (thinkingBlock) {
		console.log(`  thinking block: "${(thinkingBlock.thinking ?? "").slice(0, 80)}..."`);
		console.log(`  signature: ${thinkingBlock.signature ? `${thinkingBlock.signature.slice(0, 40)}...` : "无"}`);
	}

	await delay(3000);

	// 第 2 步：thinking=false，但保留 thinking blocks 在历史中
	console.log("\n  请求 2 (thinking=false，保留历史 thinking blocks)...");
	const assistantContent: Array<Record<string, unknown>> = [];
	if (thinkingBlock) {
		assistantContent.push({
			type: "thinking",
			thinking: thinkingBlock.thinking,
			signature: thinkingBlock.signature,
		});
	}
	if (textBlock) {
		assistantContent.push({ type: "text", text: textBlock.text });
	}

	const r2 = await sendRequest({
		system: systemBlocks,
		messages: [
			userMsg,
			{ role: "assistant", content: assistantContent },
			{ role: "user", content: "Now what is 3+3?" },
		],
		// 不设 thinking → thinking disabled
		tools: TOOLS,
	});
	printUsage("R2 (thinking=false, 保留 thinking blocks)", r2.usage);

	// 第 3 步：对照组 - thinking=false，但也不保留 thinking blocks
	await delay(3000);

	console.log("  请求 3 (thinking=false，剥离 thinking blocks 对照)...");
	const assistantContentStripped: Array<Record<string, unknown>> = [];
	if (textBlock) {
		assistantContentStripped.push({ type: "text", text: textBlock.text });
	}

	const r3 = await sendRequest({
		system: systemBlocks,
		messages: [
			userMsg,
			{ role: "assistant", content: assistantContentStripped },
			{ role: "user", content: "Now what is 3+3?" },
		],
		tools: TOOLS,
	});
	printUsage("R3 (thinking=false, 剥离 thinking blocks)", r3.usage);

	console.log("  对比分析：");
	console.log(
		`    R2 (保留 thinking)  cache_read: ${r2.usage.cache_read_input_tokens ?? 0}, cache_write: ${r2.usage.cache_creation_input_tokens ?? 0}`,
	);
	console.log(
		`    R3 (剥离 thinking)  cache_read: ${r3.usage.cache_read_input_tokens ?? 0}, cache_write: ${r3.usage.cache_creation_input_tokens ?? 0}`,
	);
	console.log(
		`    R2 input_tokens: ${r2.usage.input_tokens}, R3 input_tokens: ${r3.usage.input_tokens}`,
	);
	console.log("");
}

// ── 实验 C：验证 system+tools cache 在 thinking 切换时存活 ──
async function experimentC() {
	console.log("═".repeat(70));
	console.log("实验 C：验证 system+tools cache 在 thinking 切换后是否存活");
	console.log("预期：system+tools 部分应有 cache hit（文档声明如此）");
	console.log("═".repeat(70));

	const systemBlocks = [
		{ type: "text" as const, text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } },
	];
	const simpleMsg = [{ role: "user", content: "Say hi." }];

	// 第 1 步：thinking=true
	console.log("\n  请求 1 (thinking=true, 建立 system+tools cache)...");
	const r1 = await sendRequest({
		system: systemBlocks,
		messages: simpleMsg,
		thinking: { type: "enabled", budget_tokens: 1024 },
		tools: TOOLS,
	});
	printUsage("R1 (thinking=true)", r1.usage);

	await delay(3000);

	// 第 2 步：thinking=false，但完全不同的 user 消息
	// 这样 message 部分必然不同，只能 hit system+tools
	console.log("  请求 2 (thinking=false, 不同消息 → 只测 system+tools cache)...");
	const r2 = await sendRequest({
		system: systemBlocks,
		messages: [{ role: "user", content: "Say goodbye." }],
		tools: TOOLS,
	});
	printUsage("R2 (thinking=false, 不同消息)", r2.usage);

	// 第 3 步：再次 thinking=true，相同消息
	await delay(3000);
	console.log("  请求 3 (thinking=true, 同消息 → 完整 cache hit?)...");
	const r3 = await sendRequest({
		system: systemBlocks,
		messages: simpleMsg,
		thinking: { type: "enabled", budget_tokens: 1024 },
		tools: TOOLS,
	});
	printUsage("R3 (thinking=true, 与 R1 同参数)", r3.usage);

	console.log("  对比分析：");
	console.log(
		`    R1 cache_write: ${r1.usage.cache_creation_input_tokens ?? 0}`,
	);
	console.log(
		`    R2 cache_read:  ${r2.usage.cache_read_input_tokens ?? 0} (切换 thinking 后 system+tools)`,
	);
	console.log(
		`    R3 cache_read:  ${r3.usage.cache_read_input_tokens ?? 0} (恢复 thinking 后完整 cache)`,
	);
	console.log("");
}

// ── 实验 D：thinking=true 连续对话中 thinking blocks 对 cache 的影响 ──
async function experimentD() {
	console.log("═".repeat(70));
	console.log("实验 D：连续 thinking=true 对话 → 包含/排除 thinking blocks 的 cache 差异");
	console.log("验证: 传回 thinking blocks 是否帮助 cache hit (Opus 4.6 保留 thinking by default)");
	console.log("═".repeat(70));

	const systemBlocks = [
		{ type: "text" as const, text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } },
	];
	const thinking = { type: "enabled" as const, budget_tokens: 1024 };
	const userMsg = { role: "user", content: "What is 2+2? Answer briefly." };

	console.log("\n  请求 1 (thinking=true, 初始)...");
	const r1 = await sendRequest({
		system: systemBlocks,
		messages: [userMsg],
		thinking,
		tools: TOOLS,
	});
	printUsage("R1", r1.usage);

	const thinkingBlock = r1.content.find((b) => b.type === "thinking");
	const textBlock = r1.content.find((b) => b.type === "text");

	await delay(3000);

	// 第 2 步：thinking=true，包含 thinking blocks 的多轮
	console.log("  请求 2a (thinking=true, 保留 thinking blocks)...");
	const assistantWithThinking: Array<Record<string, unknown>> = [];
	if (thinkingBlock) {
		assistantWithThinking.push({
			type: "thinking",
			thinking: thinkingBlock.thinking,
			signature: thinkingBlock.signature,
		});
	}
	if (textBlock) {
		assistantWithThinking.push({ type: "text", text: textBlock.text });
	}

	const r2a = await sendRequest({
		system: systemBlocks,
		messages: [
			userMsg,
			{ role: "assistant", content: assistantWithThinking },
			{ role: "user", content: "Now what is 3+3?" },
		],
		thinking,
		tools: TOOLS,
	});
	printUsage("R2a (保留 thinking)", r2a.usage);

	await delay(3000);

	// 第 2 步 variant：thinking=true，但剥离 thinking blocks
	console.log("  请求 2b (thinking=true, 剥离 thinking blocks)...");
	const assistantWithout: Array<Record<string, unknown>> = [];
	if (textBlock) {
		assistantWithout.push({ type: "text", text: textBlock.text });
	}

	const r2b = await sendRequest({
		system: systemBlocks,
		messages: [
			userMsg,
			{ role: "assistant", content: assistantWithout },
			{ role: "user", content: "Now what is 3+3?" },
		],
		thinking,
		tools: TOOLS,
	});
	printUsage("R2b (剥离 thinking)", r2b.usage);

	console.log("  对比分析：");
	console.log(
		`    R2a (保留) cache_read: ${r2a.usage.cache_read_input_tokens ?? 0}, input: ${r2a.usage.input_tokens}`,
	);
	console.log(
		`    R2b (剥离) cache_read: ${r2b.usage.cache_read_input_tokens ?? 0}, input: ${r2b.usage.input_tokens}`,
	);
	console.log(
		`    差异: cache_read diff=${(r2a.usage.cache_read_input_tokens ?? 0) - (r2b.usage.cache_read_input_tokens ?? 0)}, input diff=${r2a.usage.input_tokens - r2b.usage.input_tokens}`,
	);
	console.log("");
}

// ── 运行 ──
console.log("╔══════════════════════════════════════════════════════════════╗");
console.log("║  Thinking ↔ Cache 交互实验                                  ║");
console.log("║  模型: " + MODEL.padEnd(52) + "║");
console.log("╚══════════════════════════════════════════════════════════════╝\n");

try {
	await experimentA();
	await delay(2000);
	await experimentB();
	await delay(2000);
	await experimentC();
	await delay(2000);
	await experimentD();
} catch (err) {
	console.error("实验中断:", err);
}

console.log("\n" + "═".repeat(70));
console.log("全部实验完成");
console.log("═".repeat(70));
