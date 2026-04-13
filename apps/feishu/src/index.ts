/**
 * 飞书 Bot 服务入口
 *
 * @deprecated 此模块不再维护
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
 *
 * 启动流程：
 * 1. bootstrap — 检测 .env / 必填配置 / LLM 连通性，展示配置摘要
 * 2. 初始化飞书 WebSocket 长连接
 * 3. 分发消息事件
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import * as lark from "@larksuiteoapi/node-sdk";
import { createRuntimeContext, initRuntime } from "@n0n/core";
import { buildLLMConfigFromEnv, createLLMClient } from "@n0n/llm";
import {
	loadSchedules,
	type SchedulerCallbacks,
	type SchedulerHandle,
	startScheduler,
} from "@n0n/scheduler";
import { bootstrap } from "@n0n/shared";
import { FeishuBot } from "./bot.ts";
import { handleCardAction } from "./card-actions.ts";
import { buildTextCard } from "./cards/index.ts";
import { handleCommand, parseCommand, parseMenuCommand } from "./commands.ts";
import { buildFeishuEnvSpec } from "./env-spec.ts";
import { discoverAllUserPaths, resolveFeishuPaths } from "./paths.ts";
import feishuPromptText from "./prompts/feishu.md" with { type: "text" };
import { runFeishuRound } from "./round.ts";
import {
	buildSessionKey,
	getOrCreateSession,
	shouldProcessMessage,
} from "./session.ts";
import { ServerSetupRenderer } from "./setup-renderer.ts";
import { ensureUserInfo } from "./user-info.ts";

export async function startFeishuService(): Promise<void> {
	// bootstrap 已确保必填变量存在，此处直接读取
	const appId = process.env.FEISHU_APP_ID ?? "";
	const appSecret = process.env.FEISHU_APP_SECRET ?? "";
	const encryptKey = process.env.FEISHU_ENCRYPT_KEY;
	const domain = process.env.FEISHU_DOMAIN === "lark" ? "lark" : "feishu";

	const bot = new FeishuBot({ appId, appSecret, domain });
	const systemPrompt = feishuPromptText;

	const llmConfig = buildLLMConfigFromEnv("LLM");
	const editorLlmConfig = buildLLMConfigFromEnv(
		"EDITOR_LLM",
		llmConfig.providerConfig,
	);
	const runtime = createRuntimeContext({
		client: createLLMClient(llmConfig),
		editBackend: { type: "str-replace", editorClient: createLLMClient(editorLlmConfig) },
	});
	initRuntime(runtime);

	// ── Scheduler 回调：将定时任务结果/错误推送给用户 ──
	function buildSchedulerCallbacks(workspace: string): SchedulerCallbacks {
		const userOpenId = basename(workspace);
		const recipient = {
			receiveIdType: "open_id" as const,
			receiveId: userOpenId,
		};
		const notifyCtx = {
			chatId: null,
			chatType: null,
			senderOpenId: userOpenId,
			senderUserId: null,
			senderUnionId: null,
			tenantKey: null,
			messageId: null,
			recipient,
		};
		return {
			onTaskComplete: async (entry, result) => {
				const text =
					typeof result === "string"
						? result.slice(0, 500)
						: JSON.stringify(result).slice(0, 500);
				const card = buildTextCard(
					`✅ 定时任务完成: ${entry.name}`,
					text,
					"green",
				);
				await bot.createCardMessage(notifyCtx, card).catch((err) => {
					console.error(`[feishu] Failed to notify task completion:`, err);
				});
			},
			onTaskError: async (entry, error) => {
				const card = buildTextCard(
					`❌ 定时任务失败: ${entry.name}`,
					String(error).slice(0, 500),
					"red",
				);
				await bot.createCardMessage(notifyCtx, card).catch((err) => {
					console.error(`[feishu] Failed to notify task error:`, err);
				});
			},
		};
	}

	async function startUserScheduler(
		workspace: string,
		paths: import("@n0n/workflow").WorkflowPaths,
	): Promise<SchedulerHandle> {
		return startScheduler(paths, buildSchedulerCallbacks(workspace));
	}

	// 扫描所有已有用户目录，为有 schedule 的用户启动 scheduler
	const schedulerMap = new Map<string, SchedulerHandle>();
	const allUserPaths = discoverAllUserPaths();
	for (const userPaths of allUserPaths) {
		const schedules = await loadSchedules(userPaths);
		if (schedules.length > 0) {
			console.log(
				`[feishu] Starting scheduler for ${userPaths.workspace} (${schedules.length} schedules)`,
			);
			const handle = await startUserScheduler(userPaths.workspace, userPaths);
			schedulerMap.set(userPaths.workspace, handle);
		}
	}
	if (schedulerMap.size === 0) {
		console.log("[feishu] No user schedules found at startup.");
	}

	process.on("SIGINT", () => {
		for (const h of schedulerMap.values()) h.stop();
	});

	const dispatcher = new lark.EventDispatcher({
		encryptKey,
	}).register({
		"im.message.receive_v1": async (data) => {
			const ctx = FeishuBot.buildContext(data);
			if (!ctx) return;
			if (!shouldProcessMessage(ctx)) {
				console.log(
					`[feishu] duplicate message skipped: chat=${ctx.chatId}, message=${ctx.messageId}`,
				);
				return;
			}

			const messageType = data?.message?.message_type;
			if (messageType !== "text") {
				if (ctx.senderOpenId) {
					const card = buildTextCard(
						"暂不支持",
						"目前仅支持文本消息，图片、文件等类型暂不支持。",
						"grey",
					);
					await bot.createCardMessage(ctx, card);
				}
				return;
			}

			const text = FeishuBot.readText(data);
			if (!text) return;

			if (!ctx.senderOpenId) {
				console.warn("[feishu] message with empty senderOpenId, skipping");
				return;
			}

			const sessionKey = buildSessionKey(ctx);
			const workspacePaths = resolveFeishuPaths(ctx.senderOpenId);

			// 懒加载用户信息（首次对话时调 API，后续按 TTL 刷新）
			const userInfo = await ensureUserInfo(
				bot,
				ctx.senderOpenId,
				workspacePaths.memory,
			);

			const session = getOrCreateSession(
				sessionKey,
				ctx,
				systemPrompt,
				workspacePaths,
				userInfo,
			);

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
				.finally(async () => {
					if (session.currentTask?.abortController === abortController) {
						session.currentTask = null;
					}
					// 动态检查是否需要为该用户启动 scheduler
					if (!schedulerMap.has(workspacePaths.workspace)) {
						const schedules = await loadSchedules(workspacePaths);
						if (schedules.length > 0) {
							console.log(
								`[feishu] Starting scheduler for new user ${ctx.senderOpenId} (${schedules.length} schedules)`,
							);
							const handle = await startUserScheduler(
								workspacePaths.workspace,
								workspacePaths,
							);
							schedulerMap.set(workspacePaths.workspace, handle);
						}
					}
				});
		},

		"application.bot.menu_v6": async (data) => {
			const ctx = FeishuBot.buildContextForMenu(data);
			if (!ctx) return;

			if (!ctx.senderOpenId) {
				console.warn("[feishu] menu event with empty senderOpenId, skipping");
				return;
			}

			const sessionKey = buildSessionKey(ctx);
			const workspacePaths = resolveFeishuPaths(ctx.senderOpenId);

			const userInfo = await ensureUserInfo(
				bot,
				ctx.senderOpenId ?? "unknown",
				workspacePaths.memory,
			);

			const session = getOrCreateSession(
				sessionKey,
				ctx,
				systemPrompt,
				workspacePaths,
				userInfo,
			);

			const menuCommand = parseMenuCommand(data?.event_key);
			if (!menuCommand) {
				console.log(
					`[feishu] unknown menu event_key: ${data?.event_key} (sessionKey=${sessionKey})`,
				);
				return;
			}

			console.log(
				`[feishu] menu event: ${data?.event_key} (sessionKey=${sessionKey})`,
			);
			await handleCommand(menuCommand, bot, sessionKey, session, systemPrompt);
		},

		"card.action.trigger": async (data: Record<string, unknown>) => {
			console.log("[feishu] card action event received");
			return await handleCardAction(bot, data);
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
	// ── Bootstrap ──
	// 配置文件存放在全局目录 ~/.n0n/，与 code agent 共享
	const globalConfigDir = resolve(homedir(), ".n0n");
	if (!existsSync(globalConfigDir)) {
		mkdirSync(globalConfigDir, { recursive: true });
	}

	const setupUI = new ServerSetupRenderer();

	/** LLM 连通性测试回调 — 注入到 bootstrap，避免 shared 直接依赖 llm */
	const testLLM = async () => {
		try {
			const config = buildLLMConfigFromEnv("LLM");
			const client = createLLMClient(config);
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 15_000);
			try {
				for await (const event of client.stream(
					{ messages: [{ type: "generic_user_text", content: "hi" }] },
					controller.signal,
				)) {
					if (event.type === "error") {
						return { ok: false as const, error: event.error };
					}
					controller.abort();
					break;
				}
			} finally {
				clearTimeout(timeout);
			}
			return { ok: true as const };
		} catch (err) {
			if (err instanceof Error) {
				if (err.message.includes("401") || err.message.includes("403")) {
					return { ok: false as const, error: "认证失败，请检查 API Key" };
				}
				if (err.name === "TimeoutError" || err.message.includes("timeout")) {
					return {
						ok: false as const,
						error: "连接超时（15s），请检查网络或 API 地址",
					};
				}
				return { ok: false as const, error: err.message.slice(0, 200) };
			}
			return { ok: false as const, error: `连接失败: ${String(err)}` };
		}
	};

	const provider = process.env.LLM_PROVIDER ?? "openai";
	const result = await bootstrap(
		buildFeishuEnvSpec(provider),
		setupUI,
		globalConfigDir,
		testLLM,
	);
	setupUI.dispose();

	if (!result.ok) {
		process.exit(1);
	}

	startFeishuService().catch((err) => {
		console.error("[feishu] fatal error:", err);
		process.exit(1);
	});
}
