/**
 * 飞书 Bot 服务入口
 *
 * 职责：初始化飞书 WebSocket 连接，分发消息事件到各模块。
 * 业务逻辑已拆分至：
 * - session.ts — 会话管理与去重
 * - commands.ts — 斜杠命令解析与处理
 * - round.ts — Agent 对话轮次执行
 * - renderer.ts — 飞书流式渲染器
 * - conversation.ts — 飞书消息生命周期管理
 * - cards/ — 卡片构建模板
 * - bot.ts — 飞书 API 客户端
 */

import { fileURLToPath } from "node:url";
import * as lark from "@larksuiteoapi/node-sdk";
import { startScheduler } from "@n0n/core";
import { FeishuBot } from "./bot.ts";
import { buildTextCard } from "./cards/index.ts";
import { handleCommand, parseCommand } from "./commands.ts";
import { runFeishuRound } from "./round.ts";
import {
	buildSessionKey,
	getOrCreateSession,
	shouldProcessMessage,
} from "./session.ts";

const PROMPT_PATH = fileURLToPath(
	new URL("../../cli/src/prompts/interactive.md", import.meta.url),
);

function requireEnv(key: string): string {
	const val = process.env[key];
	if (!val) throw new Error(`Missing required env: ${key}`);
	return val;
}

export async function startFeishuService(): Promise<void> {
	const appId = requireEnv("FEISHU_APP_ID");
	const appSecret = requireEnv("FEISHU_APP_SECRET");
	const encryptKey = process.env.FEISHU_ENCRYPT_KEY;
	const domain = process.env.FEISHU_DOMAIN === "lark" ? "lark" : "feishu";

	const bot = new FeishuBot({ appId, appSecret, domain });
	const systemPrompt = await Bun.file(PROMPT_PATH).text();

	await startScheduler();

	const dispatcher = new lark.EventDispatcher({
		encryptKey,
	}).register({
		"im.message.receive_v1": async (data: any) => {
			const ctx = FeishuBot.buildContext(data);
			if (!ctx) return;
			if (!shouldProcessMessage(ctx)) {
				console.log(
					`[feishu] duplicate message skipped: chat=${ctx.chatId}, message=${ctx.messageId}`,
				);
				return;
			}

			const text = FeishuBot.readText(data);
			if (!text) return;

			const sessionKey = buildSessionKey(ctx);
			const session = getOrCreateSession(sessionKey, ctx, systemPrompt);

			console.log(
				`[feishu] received message: ${text} (sessionKey=${sessionKey})`,
			);

			// 斜杠命令
			const command = parseCommand(text);
			if (command) {
				await handleCommand(command, bot, sessionKey, session, systemPrompt);
				return;
			}

			// 任务并发保护
			if (session.currentTask) {
				const elapsedSec = Math.floor(
					(Date.now() - session.currentTask.startedAt) / 1000,
				);
				const card = buildTextCard(
					"任务执行中",
					`当前任务仍在执行中（${elapsedSec}s）。发送 /exit 可打断。`,
					"orange",
				);
				await bot.createCardMessage(ctx, card);
				return;
			}

			// 启动 agent round
			const abortController = new AbortController();
			session.currentTask = {
				abortController,
				startedAt: Date.now(),
			};

			runFeishuRound(bot, session, text, abortController)
				.catch(async (err) => {
					if (abortController.signal.aborted) return;
					console.error("[feishu] runFeishuRound error:", err);
					const card = buildTextCard(
						"任务执行失败",
						`❌ ${String(err)}`,
						"red",
					);
					await bot.createCardMessage(ctx, card);
				})
				.finally(() => {
					if (session.currentTask?.abortController === abortController) {
						session.currentTask = null;
					}
				});
		},

		"application.bot.menu_v6": async (data: any) => {
			const ctx = FeishuBot.buildContextForMenu(data);
			if (!ctx) return;

			const sessionKey = buildSessionKey(ctx);
			const session = getOrCreateSession(sessionKey, ctx, systemPrompt);

			console.log(
				`[feishu] menu event: ${data?.event_key} (sessionKey=${sessionKey})`,
			);
			await handleCommand(
				{ type: data?.event_key },
				bot,
				sessionKey,
				session,
				systemPrompt,
			);
		},
	});

	const wsClient = new lark.WSClient({
		appId,
		appSecret,
		domain: domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
		loggerLevel: lark.LoggerLevel.info,
	});

	wsClient.start({ eventDispatcher: dispatcher });
	console.log("[feishu] long connection mode started (WSClient)");
}

if (import.meta.main) {
	startFeishuService().catch((err) => {
		console.error("[feishu] fatal error:", err);
		process.exit(1);
	});
}
