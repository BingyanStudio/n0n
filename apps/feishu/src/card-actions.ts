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

import { loadSchedules, setScheduleEnabled } from "@n0n/scheduler";
import {
	discoverWorkflows,
	runWorkflow,
	type WorkflowPaths,
} from "@n0n/workflow";
import type { FeishuBot, FeishuMessageContext } from "./bot.ts";
import {
	buildCronListCard,
	buildTextCard,
	type CronItem,
} from "./cards/index.ts";
import type { FeishuCardContent } from "./cards/types.ts";
import { resolveFeishuPaths } from "./paths.ts";

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
	paths: WorkflowPaths;
	/** 按钮 value 数据 */
	value: CardActionValue;
	/** 原始卡片 message_id（用于更新卡片） */
	messageId: string | null;
}

/**
 * 卡片回调响应 — SDK 会将返回值作为 WebSocket 响应发回飞书。
 * - card: 原地更新卡片内容
 * - toast: 显示轻提示
 */
export interface CardActionResponse {
	card?: FeishuCardContent;
	toast?: { type: "success" | "error" | "info"; content: string };
}

// ── 主处理器 ──

/**
 * 从 card.action.trigger 事件数据中提取上下文并路由到对应处理函数。
 * 返回 CardActionResponse 供 SDK 作为回调响应发回飞书（原地更新卡片），
 * 返回 undefined 表示无需即时更新。
 */
export async function handleCardAction(
	bot: FeishuBot,
	data: FeishuCardActionData,
): Promise<CardActionResponse | undefined> {
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
		paths: resolveFeishuPaths(operatorId),
		value,
		messageId,
	};

	console.log(`[feishu] card action: ${value.action}`, value);

	switch (value.action) {
		case "workflow_run":
			return onWorkflowRun(ctx);
		case "cron_toggle":
			return onCronToggle(ctx);
		case "cron_run":
			return onCronRun(ctx);
		default:
			console.warn(`[feishu] unknown card action: ${value.action}`);
			return undefined;
	}
}

// ── Action 处理函数 ──

async function onWorkflowRun(
	ctx: CardActionContext,
): Promise<CardActionResponse | undefined> {
	// TODO
	// ctx.value.name as string → CardActionValue 的索引签名返回 unknown，
	// 应添加类型守卫或收紧 CardActionValue 类型定义。onCronToggle、onCronRun 的同类 cast 同理。
	// ODOT
	const name = ctx.value.name as string;
	if (!name) return undefined;

	const workflows = await discoverWorkflows(false, ctx.paths);
	const wf = workflows.find((w) => w.name === name);
	if (!wf) {
		return { toast: { type: "error", content: `未找到工作流: ${name}` } };
	}

	// 异步执行工作流（回调有 5s 超时限制），完成后通过 PATCH API 发送结果
	runWorkflow(wf.path, undefined, ctx.paths.workspace).then(
		async (result) => {
			await sendFeedback(ctx, `✅ ${name}`, formatResult(result), "green");
		},
		async (err) => {
			await sendFeedback(ctx, `❌ ${name}`, String(err), "red");
		},
	);

	return { toast: { type: "info", content: `⏳ 正在运行: ${name}...` } };
}

async function onCronToggle(
	ctx: CardActionContext,
): Promise<CardActionResponse | undefined> {
	const name = ctx.value.name as string;
	const enabled = ctx.value.enabled as boolean;
	if (!name || enabled === undefined) return undefined;

	const ok = await setScheduleEnabled(name, enabled, ctx.paths);
	if (!ok) {
		return { toast: { type: "error", content: `未找到: ${name}` } };
	}

	// 重新加载并返回更新后的卡片（SDK 会原地替换）
	const schedules = await loadSchedules(ctx.paths);
	const crons: CronItem[] = schedules.map((s) => ({
		name: s.name,
		cron: s.cron,
		prompt: s.prompt,
		enabled: s.enabled,
	}));

	return { card: buildCronListCard(crons) };
}

async function onCronRun(
	ctx: CardActionContext,
): Promise<CardActionResponse | undefined> {
	const name = ctx.value.name as string;
	if (!name) return undefined;

	const schedules = await loadSchedules(ctx.paths);
	const schedule = schedules.find((s) => s.name === name);
	if (!schedule) {
		return { toast: { type: "error", content: `未找到: ${name}` } };
	}

	if (!schedule.workflow) {
		return {
			toast: {
				type: "error",
				content: `${name} 没有关联工作流（使用 delegateTask）`,
			},
		};
	}

	// 异步执行工作流，完成后通过 PATCH API 发送结果
	runWorkflow(schedule.workflow, undefined, ctx.paths.workspace).then(
		async (result) => {
			await sendFeedback(ctx, `✅ ${name}`, formatResult(result), "green");
		},
		async (err) => {
			await sendFeedback(ctx, `❌ ${name}`, String(err), "red");
		},
	);

	return { toast: { type: "info", content: `⏳ 正在运行: ${name}...` } };
}

// ── 辅助 ──

/**
 * 将工作流执行结果格式化为可读的 Markdown 文本。
 * - string: 直接展示（通常已是 markdown）
 * - object with report/result/message: 提取文本字段展示
 * - 其他 object: JSON 代码块
 */
function formatResult(result: unknown): string {
	if (result == null) return "(无返回值)";
	if (typeof result === "string") return result || "(空字符串)";

	if (typeof result === "object" && !Array.isArray(result)) {
		const obj = result as Record<string, unknown>;
		// 优先提取常见的文本字段
		const text = obj.report ?? obj.result ?? obj.message ?? obj.content;
		if (typeof text === "string" && text.trim()) return text;
	}

	return `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
}

async function sendFeedback(
	ctx: CardActionContext,
	title: string,
	text: string,
	tpl: "blue" | "green" | "red" | "orange" = "blue",
): Promise<void> {
	const card = buildTextCard(title, text, tpl);
	await ctx.bot.createCardMessage(ctx.operatorCtx, card);
}
