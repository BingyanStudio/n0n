/**
 * FeishuConversation — 飞书会话消息管理器
 *
 * 管理一次 agent round 中的飞书消息生命周期：
 * - 使用单张「步骤流卡片」实时更新进度（模仿 CLI 流式体验）
 * - 通过队列串行化所有飞书 API 调用，避免竞态
 * - 步骤状态可视化：⏳ 进行中 / ✅ 完成 / ❌ 失败
 */

import type { FeishuBot, FeishuMessageContext } from "./bot.ts";
import {
	buildStepCard,
	buildTextCard,
	type CardHeaderTemplate,
	type StepEntry,
} from "./cards/index.ts";

/** 单张卡片内容上限（飞书限制约 28KB，留余量） */
const MAX_DETAIL_LEN = 800;
const MAX_STEPS = 50;

/** 截断文本 */
function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}...(truncated)`;
}

export class FeishuConversation {
	private queue: Promise<void> = Promise.resolve();
	private steps: StepEntry[] = [];
	private currentActivity = "";
	private summaryText = "";
	private cardTitle = "🤖 Agent 工作中...";
	private cardTemplate: CardHeaderTemplate = "blue";
	private cardMessageId: string | null = null;

	private constructor(
		private readonly bot: FeishuBot,
		private readonly ctx: FeishuMessageContext,
	) {}

	/**
	 * 创建会话：发送初始步骤卡片
	 */
	static async create(
		bot: FeishuBot,
		ctx: FeishuMessageContext,
	): Promise<FeishuConversation> {
		const conv = new FeishuConversation(bot, ctx);
		const card = buildStepCard({
			title: conv.cardTitle,
			template: conv.cardTemplate,
			steps: [],
			currentActivity: "初始化中...",
		});
		conv.cardMessageId = await bot.createCardMessage(ctx, card);
		return conv;
	}

	/** 等待所有排队的消息操作完成 */
	drain(): Promise<void> {
		return this.queue;
	}

	/** 更新卡片标题 */
	setTitle(title: string, template?: CardHeaderTemplate): void {
		this.cardTitle = title;
		if (template) this.cardTemplate = template;
		this.flushCard();
	}

	/** 添加新步骤 */
	addStep(step: StepEntry): void {
		this.steps.push(step);
		if (this.steps.length > MAX_STEPS) {
			this.steps = this.steps.slice(-MAX_STEPS);
		}
		this.currentActivity = "";
		this.flushCard();
	}

	/** 更新最后一个步骤的状态 */
	updateLastStep(update: Partial<StepEntry>): void {
		const last = this.steps[this.steps.length - 1];
		if (!last) return;
		Object.assign(last, update);
		this.flushCard();
	}

	/** 设置当前活动文本（流式思考/输出） */
	setActivity(text: string): void {
		this.currentActivity = truncate(text, MAX_DETAIL_LEN);
		this.flushCard();
	}

	/** 设置总结文本 */
	setSummary(text: string): void {
		this.summaryText = text;
		this.flushCard();
	}

	/** 完成：更新卡片为最终状态 */
	finish(title: string, template: CardHeaderTemplate, summary: string): void {
		this.cardTitle = title;
		this.cardTemplate = template;
		this.summaryText = summary;
		this.currentActivity = "";
		this.flushCard();
	}

	/** 发送独立卡片（不影响步骤流卡片） */
	sendSeparateCard(title: string, text: string): void {
		this.enqueue(async () => {
			const card = buildTextCard(title, text);
			await this.bot.createCardMessage(this.ctx, card);
		});
	}

	/** 将当前状态刷新到飞书卡片 */
	private flushCard(): void {
		this.enqueue(async () => {
			if (!this.cardMessageId) return;
			const card = buildStepCard({
				title: this.cardTitle,
				template: this.cardTemplate,
				steps: this.steps,
				currentActivity: this.currentActivity || undefined,
				summary: this.summaryText || undefined,
			});
			await this.bot.editCardMessage(this.cardMessageId, card);
		});
	}

	/** 串行化队列 */
	private enqueue(task: () => Promise<void>): void {
		this.queue = this.queue.then(task).catch((err) => {
			console.error("[feishu] message update failed:", err);
		});
	}
}
