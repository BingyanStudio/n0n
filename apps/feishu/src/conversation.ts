/**
 * FeishuConversation — 飞书会话消息管理器
 *
 * 管理一次 agent round 的飞书消息生命周期。
 * 核心设计：单张「过程卡片」实时更新，讲述完整因果链。
 * - 工作中：grey header，日志流逐步追加
 * - 完成后：彩色 header，底部总结
 * - 所有 API 调用通过队列串行化，避免竞态
 */

import type { FeishuBot, FeishuMessageContext } from "./bot.ts";
import {
	buildProcessCard,
	buildTextCard,
	type CardHeaderTemplate,
	type LogEntry,
} from "./cards/index.ts";

const MAX_LOGS = 60;

export class FeishuConversation {
	private queue: Promise<void> = Promise.resolve();
	private logs: LogEntry[] = [];
	private activity = "";
	private summary = "";
	private title = "n0n · 处理中";
	private template: CardHeaderTemplate = "grey";
	private cardId: string | null = null;

	private constructor(
		private readonly bot: FeishuBot,
		private readonly ctx: FeishuMessageContext,
	) {}

	/** 创建会话：发送初始过程卡片 */
	static async create(
		bot: FeishuBot,
		ctx: FeishuMessageContext,
	): Promise<FeishuConversation> {
		const conv = new FeishuConversation(bot, ctx);
		const initCard = buildProcessCard({
			title: conv.title,
			template: conv.template,
			logs: [],
			activity: "初始化...",
		});
		conv.cardId = await bot.createCardMessage(ctx, initCard);
		return conv;
	}

	/** 等待所有排队操作完成 */
	drain(): Promise<void> {
		return this.queue;
	}

	/** 追加日志条目 */
	appendLog(entry: LogEntry): void {
		this.logs.push(entry);
		if (this.logs.length > MAX_LOGS) {
			this.logs = this.logs.slice(-MAX_LOGS);
		}
		this.activity = "";
		this.flush();
	}

	/** 更新最后一条日志 */
	updateLastLog(patch: Partial<LogEntry>): void {
		const last = this.logs[this.logs.length - 1];
		if (!last) return;
		Object.assign(last, patch);
		this.flush();
	}

	/** 设置标题 */
	setTitle(title: string, template?: CardHeaderTemplate): void {
		this.title = title;
		if (template) this.template = template;
		this.flush();
	}

	/** 设置当前活动（流式状态文本） */
	setActivity(text: string): void {
		this.activity = text;
		this.flush();
	}

	/** 完成：切换为最终状态 */
	finish(title: string, template: CardHeaderTemplate, summary: string): void {
		this.title = title;
		this.template = template;
		this.summary = summary;
		this.activity = "";
		this.flush();
	}

	/** 发送独立文本卡片（不影响过程卡片） */
	sendSeparateCard(title: string, text: string): void {
		this.enqueue(async () => {
			await this.bot.createCardMessage(this.ctx, buildTextCard(title, text));
		});
	}

	/** 刷新过程卡片到飞书 */
	private flush(): void {
		this.enqueue(async () => {
			if (!this.cardId) return;
			const c = buildProcessCard({
				title: this.title,
				template: this.template,
				logs: this.logs,
				activity: this.activity || undefined,
				summary: this.summary || undefined,
			});
			await this.bot.editCardMessage(this.cardId, c);
		});
	}

	/** 串行化队列 */
	private enqueue(task: () => Promise<void>): void {
		this.queue = this.queue.then(task).catch((err) => {
			console.error("[feishu] message update failed:", err);
		});
	}
}
