import type { ToolCallRecord, ToolResult } from "../types/domain.ts";
import type { Renderer } from "../ui/renderer.ts";
import type { FeishuBot, FeishuMessageContext } from "./bot.ts";

export class FeishuRenderer implements Renderer {
	private queue: Promise<void> = Promise.resolve();
	private thinkingBuffer = "";
	private contentBuffer = "";
	private toolOutputBuffer = "";
	private readonly flushThreshold = 800;

	constructor(
		private readonly bot: FeishuBot,
		private readonly ctx: FeishuMessageContext,
	) {}

	async drain(): Promise<void> {
		await this.queue;
	}

	private enqueue(text: string): void {
		const cleaned = text.trim();
		if (!cleaned) return;
		this.queue = this.queue
			.then(() => this.bot.sendText(this.ctx, cleaned))
			.catch(() => {});
	}

	private flushThinking(): void {
		if (!this.thinkingBuffer.trim()) return;
		this.enqueue(`🧠 ${this.thinkingBuffer.trim()}`);
		this.thinkingBuffer = "";
	}

	private flushContent(): void {
		if (!this.contentBuffer.trim()) return;
		this.enqueue(`💬 ${this.contentBuffer.trim()}`);
		this.contentBuffer = "";
	}

	private flushToolOutput(): void {
		if (!this.toolOutputBuffer.trim()) return;
		this.enqueue(`📤 ${this.toolOutputBuffer.trim()}`);
		this.toolOutputBuffer = "";
	}

	userMessage(content: string): void {
		this.enqueue(`用户：${content}`);
	}

	roundStart(round: number, maxRounds: number, msgCount: number): void {
		this.enqueue(`🤖 round ${round}/${maxRounds} (${msgCount} msgs)`);
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
			this.enqueue(`助手：${content}`);
		}
		this.enqueue(`(idle=${idleCount})`);
	}

	toolCallStart(tc: ToolCallRecord): void {
		this.enqueue(`🔧 ${tc.tool}`);
	}

	toolCallArgChunk(
		_index: number,
		_name: string | undefined,
		_chunk: string,
	): void {}

	toolResultChunk(_tool: string, chunk: string): void {
		this.toolOutputBuffer += chunk;
		if (this.toolOutputBuffer.length >= this.flushThreshold) {
			this.flushToolOutput();
		}
	}

	toolCallEnd(result: ToolResult): void {
		this.flushToolOutput();
		switch (result.tool) {
			case "exec":
				this.enqueue(
					`◂ exec exit=${result.exitCode} ${(result.durationMs / 1000).toFixed(1)}s`,
				);
				break;
			case "write":
				this.enqueue(`◂ write ${result.path} ${result.success ? "ok" : "failed"}`);
				break;
			case "reminder":
				this.enqueue(`◂ reminder in ${result.delay} rounds`);
				break;
			case "submit":
				this.enqueue("◂ submit");
				break;
		}
	}

	submitAccepted(): void {
		this.enqueue("✅ submit accepted");
	}

	submitRejected(attempt: number, maxAttempts: number, error: string): void {
		this.enqueue(`❌ submit rejected (${attempt}/${maxAttempts}): ${error}`);
	}

	agentTerminated(reason: string): void {
		this.enqueue(`⚠️ agent terminated: ${reason}`);
	}
}
