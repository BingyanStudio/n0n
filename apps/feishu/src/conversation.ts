/**
 * FeishuConversation — 飞书会话消息管理器（CardKit 流式版）
 *
 * 使用 CardKit API 实现流式卡片更新：
 * - 创建卡片实体（streaming_mode=true）→ 发送卡片实体消息
 * - 文本流式更新（打字机效果）via cardElement.content
 * - 结构变更（轮次/工具）via card.update 全量更新
 * - 完成时关闭流式模式 via card.settings
 *
 * 所有飞书 API 调用通过队列串行化。
 */

import type { FeishuBot, FeishuMessageContext } from "./bot.ts";
import {
	buildProcessCard,
	buildTextCard,
	type CardTemplate,
	type LogLine,
	type RoundBlock,
} from "./cards/index.ts";

const MAX_ROUNDS = 20;
/** 流式文本元素的固定 element_id */
const STREAM_ELEMENT_ID = "stream_activity";

export class FeishuConversation {
	private queue: Promise<void> = Promise.resolve();
	private rounds: RoundBlock[] = [];
	private activity = "";
	private summary = "";
	private title = "n0n · 处理中";
	private template: CardTemplate = "grey";

	/** CardKit 卡片实体 ID */
	private cardEntityId: string | null = null;
	/** 操作序列号（CardKit API 要求递增） */
	private seq = 0;

	private constructor(
		private readonly bot: FeishuBot,
		private readonly ctx: FeishuMessageContext,
	) {}

	/** 创建会话：创建流式卡片实体并发送 */
	static async create(
		bot: FeishuBot,
		ctx: FeishuMessageContext,
	): Promise<FeishuConversation> {
		const conv = new FeishuConversation(bot, ctx);
		await conv.initStreamingCard();
		return conv;
	}

	drain(): Promise<void> {
		return this.queue;
	}

	/** 开始新轮次（结构变更 → 全量更新） */
	startRound(title: string): void {
		for (const r of this.rounds) r.active = false;
		this.rounds.push({ title, lines: [], active: true });
		if (this.rounds.length > MAX_ROUNDS) {
			this.rounds = this.rounds.slice(-MAX_ROUNDS);
		}
		this.activity = "";
		this.flushCard();
	}

	/** 向当前轮次追加日志行（结构变更 → 全量更新） */
	appendLine(line: LogLine): void {
		const cur = this.rounds[this.rounds.length - 1];
		if (cur) cur.lines.push(line);
		this.flushCard();
	}

	setTitle(title: string, template?: CardTemplate): void {
		this.title = title;
		if (template) this.template = template;
		this.flushCard();
	}

	/**
	 * 设置流式活动文本（打字机效果）。
	 * 使用 cardElement.content API 流式推送，无需全量更新卡片。
	 */
	setActivity(text: string): void {
		this.activity = text;
		if (text) {
			this.streamText(text);
		}
	}

	/** 完成：关闭流式模式，最终全量更新 */
	finish(title: string, template: CardTemplate, summary: string): void {
		this.title = title;
		this.template = template;
		this.summary = summary;
		this.activity = "";
		for (const r of this.rounds) r.active = false;
		this.closeStreamingAndFlush();
	}

	/** 发送独立卡片（不影响主过程卡片） */
	sendSeparateCard(title: string, text: string): void {
		this.enqueue(async () => {
			await this.bot.createCardMessage(this.ctx, buildTextCard(title, text));
		});
	}

	// ── 内部方法 ──

	/** 初始化：创建流式卡片实体并发送 */
	private async initStreamingCard(): Promise<void> {
		const card = buildProcessCard({
			title: this.title,
			template: this.template,
			rounds: [],
			activity: "初始化...",
			streamElementId: STREAM_ELEMENT_ID,
		});
		// 开启流式模式
		card.config.streaming_mode = true;
		card.config.summary = { content: "" };
		card.config.streaming_config = {
			print_frequency_ms: { default: 50 },
			print_step: { default: 2 },
			print_strategy: "fast",
		};

		const cardEntityId = await this.bot.createCardEntity(card);
		await this.bot.sendCardEntity(this.ctx, cardEntityId);
		this.cardEntityId = cardEntityId;
	}

	/** 流式更新文本元素（打字机效果） */
	private streamText(text: string): void {
		this.enqueue(async () => {
			if (!this.cardEntityId) return;
			this.seq++;
			await this.bot.streamCardElementContent(
				this.cardEntityId,
				STREAM_ELEMENT_ID,
				text,
				this.seq,
			);
		});
	}

	/** 全量更新卡片（结构变更时使用） */
	private flushCard(): void {
		this.enqueue(async () => {
			if (!this.cardEntityId) return;
			this.seq++;
			const card = buildProcessCard({
				title: this.title,
				template: this.template,
				rounds: this.rounds,
				activity: this.activity || undefined,
				summary: this.summary || undefined,
				streamElementId: STREAM_ELEMENT_ID,
			});
			card.config.streaming_mode = true;
			await this.bot.updateCardEntity(this.cardEntityId, card, this.seq);
		});
	}

	/** 关闭流式模式并做最终全量更新 */
	private closeStreamingAndFlush(): void {
		this.enqueue(async () => {
			if (!this.cardEntityId) return;
			// 先关闭流式模式
			this.seq++;
			await this.bot.updateCardSettings(
				this.cardEntityId,
				{ config: { streaming_mode: false } },
				this.seq,
			);
			// 最终全量更新（不含流式配置）
			this.seq++;
			const card = buildProcessCard({
				title: this.title,
				template: this.template,
				rounds: this.rounds,
				summary: this.summary || undefined,
			});
			await this.bot.updateCardEntity(this.cardEntityId, card, this.seq);
		});
	}

	private enqueue(task: () => Promise<void>): void {
		this.queue = this.queue.then(task).catch((err) => {
			// TODO: 卡片 API 错误被静默吞噬。initStreamingCard 失败后 cardEntityId=null，
			// 后续所有更新都变为空操作，用户看不到任何输出。需要：
			// 1. 添加重试机制（飞书 API 有 rate limit）
			// 2. 降级为普通消息（CardKit 流式卡片不可用时）
			// 3. 结构化错误追踪
			console.error("[feishu] card update failed:", err);
		});
	}
}
