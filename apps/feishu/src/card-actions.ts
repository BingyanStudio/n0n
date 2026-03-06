/**
 * Card Actions — 飞书卡片按钮回调处理
 *
 * 处理用户点击卡片按钮后的回调事件。
 * 通过 button.value.action 字段路由到对应处理函数。
 *
 * 支持的 action：
 * - workflow_run: 运行指定工作流
 * - cron_toggle: 启用/禁用定时任务
 * - cron_run: 立即运行定时任务的关联工作流
 */

import {
	discoverWorkflows,
	loadSchedules,
	runWorkflow,
	setScheduleEnabled,
} from "@n0n/core";
import type { FeishuBot, FeishuMessageContext } from "./bot.ts";
import {
	buildCronListCard,
	buildTextCard,
	type CronItem,
} from "./cards/index.ts";

// ── 类型 ──

/** 飞书卡片回调事件数据（card.action.trigger，SDK 未提供类型定义） */
interface FeishuCardActionData {
	operator?: { open_id?: string };
	action?: { value?: CardActionValue };
	open_message_id?: string;
	context?: { open_message_id?: string };
}

interface CardActionValue {
	action: string;
	[key: string]: unknown;
}

interface CardActionContext {
	bot: FeishuBot;
	/** 操作者的上下文（用于发送反馈消息） */
	operatorCtx: FeishuMessageContext;
	/** 按钮 value 数据 */
	value: CardActionValue;
	/** 原始卡片 message_id（用于更新卡片） */
	messageId: string | null;
}

// ── 主处理器 ──

/**
 * 从 card.action.trigger 事件数据中提取上下文并路由到对应处理函数。
 * 返回更新后的卡片 JSON（如果需要即时刷新），否则返回 undefined。
 */
export async function handleCardAction(
	bot: FeishuBot,
	data: FeishuCardActionData,
): Promise<void> {
	const operatorId = data.operator?.open_id;
	if (!operatorId) {
		console.error("[feishu] card action: missing operator open_id");
		return;
	}

	const value = data.action?.value;
	if (!value?.action) {
		console.error("[feishu] card action: missing action value");
		return;
	}

	const messageId =
		data.open_message_id ?? data.context?.open_message_id ?? null;

	const ctx: CardActionContext = {
		bot,
		operatorCtx: {
			chatId: null,
			chatType: null,
			senderOpenId: operatorId,
			senderUserId: null,
			senderUnionId: null,
			tenantKey: null,
			messageId: null,
			recipient: { receiveIdType: "open_id", receiveId: operatorId },
		},
		value,
		messageId,
	};

	console.log(`[feishu] card action: ${value.action}`, value);

	switch (value.action) {
		case "workflow_run":
			await onWorkflowRun(ctx);
			return;
		case "cron_toggle":
			await onCronToggle(ctx);
			return;
		case "cron_run":
			await onCronRun(ctx);
			return;
		default:
			console.warn(`[feishu] unknown card action: ${value.action}`);
	}
}

// ── Action 处理函数 ──

async function onWorkflowRun(ctx: CardActionContext): Promise<void> {
	const name = ctx.value.name as string;
	if (!name) return;

	const workflows = await discoverWorkflows();
	const wf = workflows.find((w) => w.name === name);
	if (!wf) {
		await sendFeedback(ctx, "工作流", `❌ 未找到: ${name}`, "red");
		return;
	}

	await sendFeedback(ctx, "工作流", `⏳ 正在运行: ${name}...`);
	try {
		const result = await runWorkflow(wf.path);
		await sendFeedback(
			ctx,
			`✅ ${name}`,
			`\`\`\`\n${JSON.stringify(result, null, 2)}\n\`\`\``,
			"green",
		);
	} catch (err) {
		await sendFeedback(ctx, `❌ ${name}`, String(err), "red");
	}
}

async function onCronToggle(ctx: CardActionContext): Promise<void> {
	const name = ctx.value.name as string;
	const enabled = ctx.value.enabled as boolean;
	if (!name || enabled === undefined) return;

	const ok = await setScheduleEnabled(name, enabled);
	if (!ok) {
		await sendFeedback(ctx, "定时任务", `❌ 未找到: ${name}`, "red");
		return;
	}

	// 刷新列表卡片
	const schedules = await loadSchedules();
	const crons: CronItem[] = schedules.map((s) => ({
		name: s.name,
		cron: s.cron,
		workflow: s.workflow ?? null,
		enabled: s.enabled,
	}));

	if (ctx.messageId) {
		const card = buildCronListCard(crons);
		await ctx.bot.editCardMessage(ctx.messageId, card);
	} else {
		await sendFeedback(
			ctx,
			"定时任务",
			`✅ ${name} 已${enabled ? "启用" : "禁用"}`,
		);
	}
}

async function onCronRun(ctx: CardActionContext): Promise<void> {
	const name = ctx.value.name as string;
	if (!name) return;

	const schedules = await loadSchedules();
	const schedule = schedules.find((s) => s.name === name);
	if (!schedule) {
		await sendFeedback(ctx, "定时任务", `❌ 未找到: ${name}`, "red");
		return;
	}

	if (!schedule.workflow) {
		await sendFeedback(
			ctx,
			"定时任务",
			`❌ ${name} 没有关联工作流（使用 delegateTask）`,
			"orange",
		);
		return;
	}

	const workflows = await discoverWorkflows();
	const wf = workflows.find((w) => w.name === schedule.workflow);
	if (!wf) {
		await sendFeedback(
			ctx,
			"定时任务",
			`❌ 关联工作流 ${schedule.workflow} 未找到`,
			"red",
		);
		return;
	}

	await sendFeedback(ctx, "定时任务", `⏳ 正在运行: ${name}...`);
	try {
		const result = await runWorkflow(wf.path);
		await sendFeedback(
			ctx,
			`✅ ${name}`,
			`\`\`\`\n${JSON.stringify(result, null, 2)}\n\`\`\``,
			"green",
		);
	} catch (err) {
		await sendFeedback(ctx, `❌ ${name}`, String(err), "red");
	}
}

// ── 辅助 ──

async function sendFeedback(
	ctx: CardActionContext,
	title: string,
	text: string,
	tpl: "blue" | "green" | "red" | "orange" = "blue",
): Promise<void> {
	const card = buildTextCard(title, text, tpl);
	await ctx.bot.createCardMessage(ctx.operatorCtx, card);
}
