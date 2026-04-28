/**
 * encoding-dsv4.ts — DeepSeek-V4 原始文本编码/解码
 *
 * Python 版 encoding_dsv4.py 的 TypeScript 等价实现，用于：
 * 1. 将 OpenAI 格式的消息序列编码为 DeepSeek-V4 模型的原始 prompt 文本
 * 2. 从模型原始输出文本解析出结构化 assistant 消息
 * 3. 预览模型实际看到的格式化结果（CLI 模式）
 *
 * 用法：
 *   bun run scripts/encoding-dsv4.ts                                    # 读取默认 .temp/code-request.json
 *   bun run scripts/encoding-dsv4.ts --json .temp/code-request.json     # 指定请求 JSON
 *   bun run scripts/encoding-dsv4.ts --out .temp/dsv4-prompt.md         # 指定输出路径
 *   bun run scripts/encoding-dsv4.ts --thinking-mode chat               # 指定 thinking mode
 *   bun run scripts/encoding-dsv4.ts --drop-thinking false              # 不丢弃历史 thinking
 *   bun run scripts/encoding-dsv4.ts --reasoning-effort max             # 设置 reasoning effort
 *
 * 编码入口：encodeMessages()
 * 解码入口：parseMessageFromCompletionText()
 */

// ============================================================
// Special Tokens
// ============================================================

export const BOS_TOKEN = "<｜begin▁of▁sentence｜>";
export const EOS_TOKEN = "<｜end▁of▁sentence｜>";
export const THINKING_START_TOKEN = "<think>";
export const THINKING_END_TOKEN = "</think>";
export const DSML_TOKEN = "｜DSML｜";

const USER_SP_TOKEN = "<｜User｜>";
const ASSISTANT_SP_TOKEN = "<｜Assistant｜>";
const LATEST_REMINDER_SP_TOKEN = "<｜latest_reminder｜>";

const DS_TASK_SP_TOKENS: Record<string, string> = {
	action: "<｜action｜>",
	query: "<｜query｜>",
	authority: "<｜authority｜>",
	domain: "<｜domain｜>",
	title: "<｜title｜>",
	read_url: "<｜read_url｜>",
};
const VALID_TASKS = new Set(Object.keys(DS_TASK_SP_TOKENS));

// ============================================================
// Types
// ============================================================

export type ThinkingMode = "chat" | "thinking";
export type ReasoningEffort = "max" | "high" | null;

export interface Message {
	role: string;
	content?: string | null;
	reasoning_content?: string | null;
	tools?: OpenAITool[];
	tool_calls?: OpenAIToolCall[];
	tool_call_id?: string;
	response_format?: unknown;
	wo_eos?: boolean;
	task?: string;
	content_blocks?: ContentBlock[];
	mask?: unknown;
}

interface ContentBlock {
	type: string;
	text?: string;
	content?: string | ContentBlock[];
	tool_use_id?: string;
}

interface OpenAITool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

interface OpenAIToolCall {
	id?: string;
	type: "function";
	function: { name: string; arguments: string };
}

interface InternalToolCall {
	name: string;
	arguments: string;
}

// ============================================================
// Templates
// ============================================================

const TOOL_CALLS_BLOCK_NAME = "tool_calls";

const REASONING_EFFORT_MAX = [
	"Reasoning Effort: Absolute maximum with no shortcuts permitted.",
	"You MUST be very thorough in your thinking and comprehensively decompose the problem to resolve the root cause, rigorously stress-testing your logic against all potential paths, edge cases, and adversarial scenarios.",
	"Explicitly write out your entire deliberation process, documenting every intermediate step, considered alternative, and rejected hypothesis to ensure absolutely no assumption is left unchecked.",
	"",
].join("\n");

const TOOLS_TEMPLATE = `## Tools

You have access to a set of tools to help answer the user's question. You can invoke tools by writing a "<\${d}tool_calls>" block like the following:

<\${d}tool_calls>
<\${d}invoke name="$TOOL_NAME">
<\${d}parameter name="$PARAMETER_NAME" string="true|false">$PARAMETER_VALUE</\${d}parameter>
...
</\${d}invoke>
<\${d}invoke name="$TOOL_NAME2">
...
</\${d}invoke>
</\${d}tool_calls>

String parameters should be specified as is and set \`string="true"\`. For all other types (numbers, booleans, arrays, objects), pass the value in JSON format and set \`string="false"\`.

If thinking_mode is enabled (triggered by \${ts}), you MUST output your complete reasoning inside \${ts}...\${te} BEFORE any tool calls or final response.

Otherwise, output directly after \${te} with tool calls or final response.

### Available Tool Schemas

\${schemas}

You MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.
`;

// ============================================================
// Utility Functions
// ============================================================

function toJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return JSON.stringify(value);
	}
}

function toolsFromOpenAIFormat(
	tools: OpenAITool[],
): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
	return tools.map((t) => t.function);
}

function toolCallsFromOpenAIFormat(toolCalls: OpenAIToolCall[]): InternalToolCall[] {
	return toolCalls.map((tc) => ({
		name: tc.function.name,
		arguments: tc.function.arguments,
	}));
}

function toolCallsToOpenAIFormat(toolCalls: InternalToolCall[]): OpenAIToolCall[] {
	return toolCalls.map((tc) => ({
		type: "function" as const,
		function: { name: tc.name, arguments: tc.arguments },
	}));
}

// ============================================================
// DSML Encoding / Decoding
// ============================================================

function encodeArgumentsToDsml(toolCall: InternalToolCall): string {
	let args: Record<string, unknown>;
	try {
		args = JSON.parse(toolCall.arguments);
	} catch {
		args = { arguments: toolCall.arguments };
	}

	const parts: string[] = [];
	for (const [k, v] of Object.entries(args)) {
		const isStr = typeof v === "string";
		const val = isStr ? (v as string) : toJson(v);
		parts.push(
			`<${DSML_TOKEN}parameter name="${k}" string="${isStr ? "true" : "false"}">${val}</${DSML_TOKEN}parameter>`,
		);
	}
	return parts.join("\n");
}

function decodeDsmlToArguments(
	toolName: string,
	toolArgs: Map<string, [value: string, isString: string]>,
): InternalToolCall {
	const pairs: string[] = [];
	for (const [k, [v, isStr]] of toolArgs) {
		pairs.push(isStr === "true" ? `${toJson(k)}: ${toJson(v)}` : `${toJson(k)}: ${v}`);
	}
	return { name: toolName, arguments: `{${pairs.join(", ")}}` };
}

// ============================================================
// Tool Schema Rendering
// ============================================================

function renderTools(
	tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
): string {
	const schemas = tools.map((t) => toJson(t)).join("\n");
	return TOOLS_TEMPLATE.replace(/\$\{d\}/g, DSML_TOKEN)
		.replace(/\$\{ts\}/g, THINKING_START_TOKEN)
		.replace(/\$\{te\}/g, THINKING_END_TOKEN)
		.replace("${schemas}", schemas);
}

// ============================================================
// Index Helpers
// ============================================================

function findLastUserIndex(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const role = messages[i]!.role;
		if (role === "user" || role === "developer") return i;
	}
	return -1;
}

// ============================================================
// Message Rendering
// ============================================================

function renderMessage(
	index: number,
	messages: Message[],
	thinkingMode: ThinkingMode,
	dropThinking = true,
	reasoningEffort: ReasoningEffort = null,
): string {
	const msg = messages[index]!;
	const lastUserIdx = findLastUserIndex(messages);
	let prompt = "";

	const role = msg.role;
	const content = msg.content ?? "";
	const responseFormat = msg.response_format;
	const reasoningContent = msg.reasoning_content ?? "";
	const woEos = msg.wo_eos ?? false;

	const toolDefs = msg.tools?.length ? toolsFromOpenAIFormat(msg.tools) : undefined;
	const internalTcs = msg.tool_calls?.length ? toolCallsFromOpenAIFormat(msg.tool_calls) : undefined;

	// Reasoning effort prefix
	if (index === 0 && thinkingMode === "thinking" && reasoningEffort === "max") {
		prompt += REASONING_EFFORT_MAX;
	}

	if (role === "system") {
		prompt += content;
		if (toolDefs) prompt += "\n\n" + renderTools(toolDefs);
		if (responseFormat) prompt += "\n\n" + `## Response Format:\n\nYou MUST strictly adhere to the following schema to reply:\n${toJson(responseFormat)}`;
	} else if (role === "developer") {
		let devContent = USER_SP_TOKEN + content;
		if (toolDefs) devContent += "\n\n" + renderTools(toolDefs);
		if (responseFormat) devContent += "\n\n" + `## Response Format:\n\nYou MUST strictly adhere to the following schema to reply:\n${toJson(responseFormat)}`;
		prompt += devContent;
	} else if (role === "user") {
		prompt += USER_SP_TOKEN;
		const blocks = msg.content_blocks;
		if (blocks?.length) {
			const parts: string[] = [];
			for (const block of blocks) {
				if (block.type === "text") {
					parts.push(block.text ?? "");
				} else if (block.type === "tool_result") {
					let tc = block.content ?? "";
					if (Array.isArray(tc)) {
						tc = tc.map((b) => (b.type === "text" ? b.text ?? "" : `[Unsupported ${b.type}]`)).join("\n\n");
					}
					parts.push(`<tool_result>${tc}</tool_result>`);
				} else {
					parts.push(`[Unsupported ${block.type}]`);
				}
			}
			prompt += parts.join("\n\n");
		} else {
			prompt += content;
		}
	} else if (role === "latest_reminder") {
		prompt += LATEST_REMINDER_SP_TOKEN + content;
	} else if (role === "tool") {
		throw new Error("deepseek_v4 merges tool messages into user; please preprocess with mergeToolMessages()");
	} else if (role === "assistant") {
		let thinkingPart = "";
		let tcContent = "";

		if (internalTcs?.length) {
			const tcList = internalTcs.map(
				(tc) => `<${DSML_TOKEN}invoke name="${tc.name}">\n${encodeArgumentsToDsml(tc)}\n</${DSML_TOKEN}invoke>`,
			);
			tcContent =
				"\n\n" +
				`<${DSML_TOKEN}${TOOL_CALLS_BLOCK_NAME}>\n${tcList.join("\n")}\n</${DSML_TOKEN}${TOOL_CALLS_BLOCK_NAME}>`;
		}

		const prevHasTask = index - 1 >= 0 && messages[index - 1]!.task != null;

		if (thinkingMode === "thinking" && !prevHasTask) {
			if (!dropThinking || index > lastUserIdx) {
				thinkingPart = reasoningContent + THINKING_END_TOKEN;
			}
		}

		const body = thinkingPart + content + tcContent;
		prompt += woEos ? body : body + EOS_TOKEN;
	} else {
		throw new Error(`Unknown role: ${role}`);
	}

	// Transition tokens based on what follows
	if (index + 1 < messages.length && !["assistant", "latest_reminder"].includes(messages[index + 1]!.role)) {
		return prompt;
	}

	const task = msg.task;
	if (task != null) {
		if (!VALID_TASKS.has(task)) throw new Error(`Invalid task: '${task}'. Valid: ${[...VALID_TASKS]}`);
		const taskSpToken = DS_TASK_SP_TOKENS[task]!;
		if (task !== "action") {
			prompt += taskSpToken;
		} else {
			prompt += ASSISTANT_SP_TOKEN;
			prompt += thinkingMode !== "thinking" ? THINKING_END_TOKEN : THINKING_START_TOKEN;
			prompt += taskSpToken;
		}
	} else if (role === "user" || role === "developer") {
		prompt += ASSISTANT_SP_TOKEN;
		if (!dropThinking && thinkingMode === "thinking") {
			prompt += THINKING_START_TOKEN;
		} else if (dropThinking && thinkingMode === "thinking" && index >= lastUserIdx) {
			prompt += THINKING_START_TOKEN;
		} else {
			prompt += THINKING_END_TOKEN;
		}
	}

	return prompt;
}

// ============================================================
// Preprocessing
// ============================================================

export function mergeToolMessages(messages: Message[]): Message[] {
	const merged: Message[] = [];

	for (const raw of messages) {
		const msg = structuredClone(raw);

		if (msg.role === "tool") {
			const toolBlock: ContentBlock = {
				type: "tool_result",
				tool_use_id: msg.tool_call_id ?? "",
				content: msg.content ?? "",
			};
			const last = merged.at(-1);
			if (last?.role === "user" && last.content_blocks) {
				last.content_blocks.push(toolBlock);
			} else {
				merged.push({ role: "user", content_blocks: [toolBlock] });
			}
		} else if (msg.role === "user") {
			const textBlock: ContentBlock = { type: "text", text: msg.content ?? "" };
			const last = merged.at(-1);
			if (last?.role === "user" && last.content_blocks && last.task == null) {
				last.content_blocks.push(textBlock);
			} else {
				const newMsg: Message = { role: "user", content: msg.content, content_blocks: [textBlock] };
				if (msg.task != null) newMsg.task = msg.task;
				if (msg.wo_eos != null) newMsg.wo_eos = msg.wo_eos;
				if (msg.mask != null) newMsg.mask = msg.mask;
				merged.push(newMsg);
			}
		} else {
			merged.push(msg);
		}
	}

	return merged;
}

export function sortToolResultsByCallOrder(messages: Message[]): Message[] {
	let lastOrder = new Map<string, number>();

	for (const msg of messages) {
		if (msg.role === "assistant" && msg.tool_calls?.length) {
			lastOrder = new Map();
			for (let i = 0; i < msg.tool_calls.length; i++) {
				const tc = msg.tool_calls[i]!;
				const id = tc.id ?? tc.function?.name ?? "";
				if (id) lastOrder.set(id, i);
			}
		} else if (msg.role === "user" && msg.content_blocks?.length) {
			const toolBlocks = msg.content_blocks.filter((b) => b.type === "tool_result");
			if (toolBlocks.length > 1 && lastOrder.size > 0) {
				const sorted = [...toolBlocks].sort(
					(a, b) => (lastOrder.get(a.tool_use_id ?? "") ?? 0) - (lastOrder.get(b.tool_use_id ?? "") ?? 0),
				);
				let si = 0;
				msg.content_blocks = msg.content_blocks.map((b) =>
					b.type === "tool_result" ? sorted[si++]! : b,
				);
			}
		}
	}
	return messages;
}

function dropThinkingMessages(messages: Message[]): Message[] {
	const lastUserIdx = findLastUserIndex(messages);
	const keepRoles = new Set(["user", "system", "tool", "latest_reminder", "direct_search_results"]);
	const result: Message[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i]!;
		if (keepRoles.has(msg.role) || i >= lastUserIdx) {
			result.push(msg);
		} else if (msg.role === "assistant") {
			const { reasoning_content: _, ...rest } = msg;
			result.push(rest);
		}
		// developer and other roles before lastUserIdx are dropped
	}
	return result;
}

// ============================================================
// Main Encoding Function
// ============================================================

export function encodeMessages(
	messages: Message[],
	thinkingMode: ThinkingMode,
	options: {
		context?: Message[];
		dropThinking?: boolean;
		addDefaultBosToken?: boolean;
		reasoningEffort?: ReasoningEffort;
	} = {},
): string {
	const {
		context: rawContext = [],
		dropThinking = true,
		addDefaultBosToken = true,
		reasoningEffort = null,
	} = options;
	let context = [...rawContext];

	// Preprocess: merge tool messages and sort tool results
	messages = mergeToolMessages(messages);
	messages = sortToolResultsByCallOrder([...context, ...messages]).slice(context.length);
	if (context.length) {
		context = sortToolResultsByCallOrder(mergeToolMessages(context));
	}

	let fullMessages = [...context, ...messages];
	let prompt = addDefaultBosToken && context.length === 0 ? BOS_TOKEN : "";

	// If any message defines tools, don't drop thinking
	let effectiveDropThinking = dropThinking;
	if (fullMessages.some((m) => m.tools?.length)) effectiveDropThinking = false;

	if (thinkingMode === "thinking" && effectiveDropThinking) {
		fullMessages = dropThinkingMessages(fullMessages);
		const numToRender = fullMessages.length - dropThinkingMessages(context).length;
		const contextLen = fullMessages.length - numToRender;
		for (let i = 0; i < numToRender; i++) {
			prompt += renderMessage(i + contextLen, fullMessages, thinkingMode, effectiveDropThinking, reasoningEffort);
		}
	} else {
		const contextLen = context.length;
		for (let i = 0; i < messages.length; i++) {
			prompt += renderMessage(i + contextLen, fullMessages, thinkingMode, effectiveDropThinking, reasoningEffort);
		}
	}

	return prompt;
}

// ============================================================
// Parsing (Decoding model output)
// ============================================================

function readUntilStop(index: number, text: string, stops: string[]): [newIndex: number, content: string, matched: string | null] {
	let minPos = text.length;
	let matched: string | null = null;
	for (const s of stops) {
		const pos = text.indexOf(s, index);
		if (pos !== -1 && pos < minPos) { minPos = pos; matched = s; }
	}
	if (matched) return [minPos + matched.length, text.slice(index, minPos), matched];
	return [text.length, text.slice(index), null];
}

export function parseToolCalls(index: number, text: string): [newIndex: number, stopToken: string | null, toolCalls: InternalToolCall[]] {
	const toolCalls: InternalToolCall[] = [];
	let stopToken: string | null = null;
	const endToken = `</${DSML_TOKEN}${TOOL_CALLS_BLOCK_NAME}>`;

	while (index < text.length) {
		let content: string;
		[index, content, stopToken] = readUntilStop(index, text, [`<${DSML_TOKEN}invoke`, endToken]);
		if (content !== ">\n") throw new Error(`Tool call format error: expected '>\\n' but got '${content}'`);
		if (stopToken === endToken) break;
		if (stopToken === null) throw new Error("Missing special token in tool calls");

		let nameContent: string;
		[index, nameContent, stopToken] = readUntilStop(index, text, [`<${DSML_TOKEN}parameter`, `</${DSML_TOKEN}invoke`]);
		const nameMatch = nameContent.match(/^\s*name="(.*?)">\n$/s);
		if (!nameMatch) throw new Error(`Tool name format error: '${nameContent}'`);
		const toolName = nameMatch[1]!;

		const toolArgs = new Map<string, [string, string]>();
		while (stopToken === `<${DSML_TOKEN}parameter`) {
			let paramContent: string;
			[index, paramContent, stopToken] = readUntilStop(index, text, [`/${DSML_TOKEN}parameter`]);
			const pm = paramContent.match(/^ name="(.*?)" string="(true|false)">(.*?)<$/s);
			if (!pm) throw new Error(`Parameter format error: '${paramContent}'`);
			if (toolArgs.has(pm[1]!)) throw new Error(`Duplicate parameter name: '${pm[1]}'`);
			toolArgs.set(pm[1]!, [pm[3]!, pm[2]!]);

			[index, content, stopToken] = readUntilStop(index, text, [`<${DSML_TOKEN}parameter`, `</${DSML_TOKEN}invoke`]);
			if (content !== ">\n") throw new Error(`Parameter format error: expected '>\\n' but got '${content}'`);
		}

		toolCalls.push(decodeDsmlToArguments(toolName, toolArgs));
	}

	return [index, stopToken, toolCalls];
}

export function parseMessageFromCompletionText(text: string, thinkingMode: ThinkingMode): {
	role: "assistant";
	content: string;
	reasoning_content: string;
	tool_calls: OpenAIToolCall[];
} {
	let summary = "", reasoning = "";
	let toolCalls: InternalToolCall[] = [];
	let index = 0, stopToken: string | null = null;
	const tcStart = `\n\n<${DSML_TOKEN}${TOOL_CALLS_BLOCK_NAME}`;
	let isToolCalling = false;

	if (thinkingMode === "thinking") {
		let delta: string;
		[index, delta, stopToken] = readUntilStop(index, text, [THINKING_END_TOKEN, tcStart]);
		reasoning = delta;
		if (stopToken !== THINKING_END_TOKEN) throw new Error("Invalid thinking format: missing </think>");
	}

	{
		let delta: string;
		[index, delta, stopToken] = readUntilStop(index, text, [EOS_TOKEN, tcStart]);
		summary = delta;
		if (stopToken === tcStart) isToolCalling = true;
		else if (stopToken !== EOS_TOKEN) throw new Error("Invalid format: missing EOS token");
	}

	if (isToolCalling) {
		[index, stopToken, toolCalls] = parseToolCalls(index, text);
		let trailing: string;
		[index, trailing, stopToken] = readUntilStop(index, text, [EOS_TOKEN]);
		if (trailing) throw new Error("Unexpected content after tool calls");
	}

	if (index !== text.length || (stopToken !== EOS_TOKEN && stopToken !== null)) {
		throw new Error("Unexpected content at end");
	}

	for (const sp of [BOS_TOKEN, EOS_TOKEN, THINKING_START_TOKEN, THINKING_END_TOKEN, DSML_TOKEN]) {
		if (summary.includes(sp) || reasoning.includes(sp)) throw new Error(`Unexpected special token '${sp}' in content`);
	}

	return { role: "assistant", content: summary, reasoning_content: reasoning, tool_calls: toolCallsToOpenAIFormat(toolCalls) };
}


// ============================================================
// CLI Preview
// ============================================================

async function main() {
	const { resolve } = await import("node:path");
	const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import("node:fs");

	const args = process.argv.slice(2);
	function getArg(name: string, fallback: string): string {
		const idx = args.indexOf(name);
		return idx !== -1 && args[idx + 1] ? args[idx + 1]! : fallback;
	}
	function getBoolArg(name: string, fallback: boolean): boolean {
		const idx = args.indexOf(name);
		if (idx === -1 || !args[idx + 1]) return fallback;
		return args[idx + 1] !== "false";
	}

	const jsonPath = resolve(getArg("--json", ".temp/code-request.json"));
	const outPath = resolve(getArg("--out", ".temp/dsv4-prompt.md"));
	const thinkingMode = getArg("--thinking-mode", "thinking") as ThinkingMode;
	const dropThinking = getBoolArg("--drop-thinking", true);
	const effort = getArg("--reasoning-effort", "null");
	const reasoningEffort: ReasoningEffort = effort === "max" ? "max" : effort === "high" ? "high" : null;

	if (!existsSync(jsonPath)) {
		console.error(`Error: ${jsonPath} not found. Run build-code-request.ts first.`);
		process.exit(1);
	}

	const request = JSON.parse(readFileSync(jsonPath, "utf-8"));
	const messages: Message[] = request.messages ?? [];

	// If the request has tools, attach them to the first system message
	if (request.tools?.length && messages.length > 0) {
		const sysMsg = messages.find((m: Message) => m.role === "system");
		if (sysMsg) sysMsg.tools = request.tools;
	}

	const encoded = encodeMessages(messages, thinkingMode, {
		dropThinking,
		addDefaultBosToken: true,
		reasoningEffort,
	});

	const outDir = resolve(outPath, "..");
	if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
	writeFileSync(outPath, encoded, "utf-8");

	const lines = encoded.split("\n").length;
	const chars = encoded.length;
	console.log(`DeepSeek-V4 prompt rendered → ${outPath}`);
	console.log(`  thinking_mode: ${thinkingMode}`);
	console.log(`  drop_thinking: ${dropThinking}`);
	console.log(`  reasoning_effort: ${reasoningEffort ?? "default"}`);
	console.log(`  messages: ${messages.length}`);
	console.log(`  output: ${lines} lines, ${chars} chars`);
}

// Run CLI if executed directly
const isMain = typeof Bun !== "undefined"
	? Bun.main === import.meta.path || import.meta.path.endsWith(process.argv[1] ?? "")
	: process.argv[1] && import.meta.url.endsWith(process.argv[1]);

if (isMain) {
	main().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
