import type { ToolCallRecord, ToolResult } from "../types/domain.ts";
import type { Renderer } from "../ui/renderer.ts";
import type {
	FeishuBot,
	FeishuMessageContext,
	FeishuPostElement,
} from "./bot.ts";

const MAX_AGENT_LOG_LINES = 80;
const MAX_TOOL_ENTRIES = 40;
const MAX_INLINE_LEN = 1000;

export interface FeishuConversationMessageRefs {
	roundMessageId: string;
	toolsMessageId: string;
	agentLogMessageId: string;
}

export class FeishuConversationMessages {
	private queue: Promise<void> = Promise.resolve();
	private agentLogLines: string[] = [];
	private toolEntries: string[] = [];
	private summaryText = "📌 总结\n处理中...";
	private readonly refs: FeishuConversationMessageRefs;
	private readonly ctx: FeishuMessageContext;

	private constructor(
		private readonly bot: FeishuBot,
		refs: FeishuConversationMessageRefs,
		ctx: FeishuMessageContext,
	) {
		this.refs = refs;
		this.ctx = ctx;
	}

	static async create(
		bot: FeishuBot,
		ctx: FeishuMessageContext,
	): Promise<FeishuConversationMessages> {
		const roundMessageId = await bot.createTextMessage(ctx, "🤖 round 0/0 (初始化中...)", "Agent 工作状态");
		const toolsMessageId = await bot.createPostMessage(ctx, {
			title: "🔧 调用工具详情",
			lines: [[{ tag: "text", text: "等待工具调用...", un_escape: true }]],
		});
		const agentLogMessageId = await bot.createCollapsibleLogMessage(
			ctx,
			"🧾 agent 输出日志",
			"日志详情",
			"(等待输出)",
		);

		return new FeishuConversationMessages(bot, {
			roundMessageId,
			toolsMessageId,
			agentLogMessageId,
		}, ctx);
	}

	drain(): Promise<void> {
		return this.queue;
	}

	updateRound(text: string): void {
		this.enqueue(async () => {
			await this.bot.editTextMessage(this.refs.roundMessageId, text);
		});
	}

	appendAgentLog(line: string): void {
		const cleaned = line.trim();
		if (!cleaned) return;
		this.agentLogLines.push(cleaned);
		if (this.agentLogLines.length > MAX_AGENT_LOG_LINES) {
			this.agentLogLines = this.agentLogLines.slice(-MAX_AGENT_LOG_LINES);
		}
		this.enqueue(async () => {
			const body = this.agentLogLines.map((entry) => `- ${entry}`).join("\n\n");
			await this.bot.editCollapsibleLogMessage(
				this.refs.agentLogMessageId,
				"🧾 agent 输出日志",
				"日志详情",
				body || "(等待输出)",
			);
		});
	}

	appendToolEntry(entry: string): void {
		const cleaned = entry.trim();
		if (!cleaned) return;
		this.toolEntries.push(cleaned);
		if (this.toolEntries.length > MAX_TOOL_ENTRIES) {
			this.toolEntries = this.toolEntries.slice(-MAX_TOOL_ENTRIES);
		}
		this.enqueue(async () => {
			await this.bot.editPostMessage(this.refs.toolsMessageId, {
				title: "🔧 调用工具详情",
				lines: this.toToolPostLines(),
			});
		});
	}

	setSummary(text: string): void {
		this.summaryText = text;
		this.enqueue(async () => {
			const summaryMessageId = await this.bot.createTextMessage(this.ctx, "处理中...", "📌 总结");
			await this.bot.editTextMessage(summaryMessageId, this.summaryText, "📌 总结");
		});
	}

	private toToolPostLines(): FeishuPostElement[][] {
		if (this.toolEntries.length === 0) {
			return [[{ tag: "text", text: "等待工具调用...", un_escape: true }]];
		}
		return this.toolEntries.map((entry) => [
			{ tag: "text", text: entry, un_escape: true },
		]);
	}

	private enqueue(task: () => Promise<void>): void {
		this.queue = this.queue.then(task).catch((err) => {
			console.error("[feishu] message update failed:", err);
		});
	}
}

interface ActiveToolCall {
	id: string;
	tool: string;
	argsText: string;
	outputBuffer: string;
}

export class FeishuRenderer implements Renderer {
	private thinkingBuffer = "";
	private contentBuffer = "";
	private readonly flushThreshold = 800;
	private activeToolCall: ActiveToolCall | null = null;

	constructor(private readonly conversation: FeishuConversationMessages) {}

	async drain(): Promise<void> {
		await this.conversation.drain();
	}

	userMessage(content: string): void {
		this.conversation.appendAgentLog(`用户输入：${inlineCode(content)}`);
	}

	roundStart(round: number, maxRounds: number, msgCount: number): void {
		this.conversation.updateRound(`🤖 round ${round}/${maxRounds} (${msgCount} msgs)`);
	}

	thinkingToken(token: string): void {
		this.thinkingBuffer += token;
		if (this.thinkingBuffer.length >= this.flushThreshold) {
			this.flushThinking();
		}
	}

	contentToken(token: string): void {
		this.contentBuffer += token;
		if (this.contentBuffer.length >= this.flushThreshold) {
			this.flushContent();
		}
	}

	contentEnd(): void {
		this.flushThinking();
		this.flushContent();
	}

	textResponse(content: string, idleCount: number): void {
		if (content) {
			this.conversation.appendAgentLog(`助手回复：${inlineCode(content)}`);
		}
		this.conversation.appendAgentLog(`idle=${idleCount}`);
	}

	toolCallStart(tc: ToolCallRecord): void {
		const argsText = safeStringify(tc.args);
		this.activeToolCall = {
			id: tc.id,
			tool: tc.tool,
			argsText,
			outputBuffer: "",
		};
		this.conversation.appendToolEntry(
			`🟡 ${tc.tool} input: ${inlineCode(argsText)}`,
		);
	}

	toolCallArgChunk(
		_index: number,
		_name: string | undefined,
		_chunk: string,
	): void {}

	toolResultChunk(_tool: string, chunk: string): void {
		if (!this.activeToolCall) return;
		this.activeToolCall.outputBuffer += chunk;
	}

	toolCallEnd(result: ToolResult): void {
		const output = this.activeToolCall?.outputBuffer ?? "";
		const summary = summarizeToolResult(result);
		const outputPart = output.trim()
			? ` output: ${inlineCode(output, MAX_INLINE_LEN)}`
			: "";
		this.conversation.appendToolEntry(`🟢 ${result.tool} ${summary}${outputPart}`);
		this.activeToolCall = null;
	}

	submitAccepted(): void {
		this.conversation.appendAgentLog("submit accepted");
	}

	submitRejected(attempt: number, maxAttempts: number, error: string): void {
		this.conversation.appendAgentLog(
			`submit rejected (${attempt}/${maxAttempts}): ${inlineCode(error)}`,
		);
	}

	agentTerminated(reason: string): void {
		this.conversation.appendAgentLog(`agent terminated: ${inlineCode(reason)}`);
	}

	private flushThinking(): void {
		if (!this.thinkingBuffer.trim()) return;
		this.conversation.appendAgentLog(
			`thinking: ${inlineCode(this.thinkingBuffer, MAX_INLINE_LEN)}`,
		);
		this.thinkingBuffer = "";
	}

	private flushContent(): void {
		if (!this.contentBuffer.trim()) return;
		this.conversation.appendAgentLog(
			`content: ${inlineCode(this.contentBuffer, MAX_INLINE_LEN)}`,
		);
		this.contentBuffer = "";
	}
}

function inlineCode(text: string, limit = 280): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (!compact) return "`(empty)`";
	const clipped = compact.length > limit ? `${compact.slice(0, limit)}...(truncated)` : compact;
	return `\`${escapeBackticks(clipped)}\``;
}

function escapeBackticks(input: string): string {
	return input.replaceAll("`", "\\`");
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function summarizeToolResult(result: ToolResult): string {
	switch (result.tool) {
		case "exec":
			return `exit=${result.exitCode}, duration=${(result.durationMs / 1000).toFixed(1)}s`;
		case "write":
			return `path=${result.path}, replaced=${result.replacedCount}, success=${result.success}`;
		case "reminder":
			return `delay=${result.delay}, acknowledged=${result.acknowledged}`;
		case "submit":
			return `result=${inlineCode(safeStringify(result.result), 240)}`;
	}
}
