/**
 * FeishuConversation — 飞书会话消息管理器
 *
 * 按轮次管理过程卡片：每个 round 是一个折叠面板，
 * 最新 round 展开，历史 round 自动折叠。
 * 所有飞书 API 调用通过队列串行化。
 */

import type { FeishuBot, FeishuMessageContext } from "./bot.ts";
import {
	buildProcessCard,
	buildTextCard,
	type CardHeaderTemplate,
	type LogLine,
	type RoundBlock,
} from "./cards/index.ts";

const MAX_ROUNDS = 20;

export class FeishuConversation {
	private queue: Promise<void> = Promise.resolve();
	private rounds: RoundBlock[] = [];
	private activity = "";
	private summary = "";
	private title = "n0n · 处理中";
	private template: CardHeaderTemplate = "grey";
	private cardId: string | null = null;

	private constructor(
		private readonly bot: FeishuBot,
		private readonly ctx: FeishuMessageContext,
	) {}

	/** 创建会话：发送初始卡片 */
	static async create(
		bot: FeishuBot,
		ctx: FeishuMessageContext,
	): Promise<FeishuConversation> {
		const conv = new FeishuConversation(bot, ctx);
		const c = buildProcessCard({
			title: conv.title,
			template: conv.template,
			rounds: [],
			activity: "初始化...",
		});
		conv.cardId = await bot.createCardMessage(ctx, c);
		return conv;
	}

	drain(): Promise<void> {
		return this.queue;
	}

	/** 开始新轮次 */
	startRound(title: string): void {
		// 将之前的 round 标记为非 active
		for (const r of this.rounds) {
			r.active = false;
		}
		this.rounds.push({ title, lines: [], active: true });
		if (this.rounds.length > MAX_ROUNDS) {
			this.rounds = this.rounds.slice(-MAX_ROUNDS);
		}
		this.activity = "";
		this.flush();
	}

	/** 向当前轮次追加日志行 */
	appendLine(line: LogLine): void {
		const cur = this.rounds[this.rounds.length - 1];
		if (cur) cur.lines.push(line);
		this.flush();
	}

	/** 设置标题 */
	setTitle(title: string, template?: CardHeaderTemplate): void {
		this.title = title;
		if (template) this.template = template;
		this.flush();
	}

	/** 设置流式活动文本 */
	setActivity(text: string): void {
		this.activity = text;
		this.flush();
	}

	/** 完成 */
	finish(title: string, template: CardHeaderTemplate, summary: string): void {
		this.title = title;
		this.template = template;
		this.summary = summary;
		this.activity = "";
		// 所有 round 折叠
		for (const r of this.rounds) {
			r.active = false;
		}
		this.flush();
	}

	/** 发送独立卡片 */
	sendSeparateCard(title: string, text: string): void {
		this.enqueue(async () => {
			await this.bot.createCardMessage(this.ctx, buildTextCard(title, text));
		});
	}

	private flush(): void {
		this.enqueue(async () => {
			if (!this.cardId) return;
			const c = buildProcessCard({
				title: this.title,
				template: this.template,
				rounds: this.rounds,
				activity: this.activity || undefined,
				summary: this.summary || undefined,
			});
			await this.bot.editCardMessage(this.cardId, c);
		});
	}

	private enqueue(task: () => Promise<void>): void {
		this.queue = this.queue.then(task).catch((err) => {
			console.error("[feishu] message update failed:", err);
		});
	}
}
