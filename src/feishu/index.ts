import * as lark from "@larksuiteoapi/node-sdk";
import { fileURLToPath } from "node:url";
import { agentLoop } from "../agent/loop.ts";
import { InteractiveResultSchema, type InteractiveResult } from "../cli/schema.ts";
import { discoverWorkflows } from "../discovery.ts";
import { loadSchedules } from "../scheduler/index.ts";
import type { DomainMessage } from "../types/domain.ts";
import { FeishuBot, type FeishuMessageContext } from "./bot.ts";
import { FeishuRenderer } from "./renderer.ts";

const PROMPT_PATH = fileURLToPath(
	new URL("../cli/prompts/interactive.md", import.meta.url),
);

interface FeishuSession {
	history: DomainMessage[];
	ctx: FeishuMessageContext;
}

const sessions = new Map<string, FeishuSession>();
const processedMessages = new Map<string, number>();
const DEDUP_TTL_MS = 10 * 60 * 1000;
const DEDUP_MAX_SIZE = 10_000;

function requireEnv(key: string): string {
	const val = process.env[key];
	if (!val) throw new Error(`Missing required env: ${key}`);
	return val;
}

function buildSessionKey(ctx: FeishuMessageContext): string {
	return [ctx.chatId, ctx.senderOpenId ?? ctx.senderUserId ?? "unknown"].join(":");
}

function buildMessageDedupKey(ctx: FeishuMessageContext): string {
	return `${ctx.chatId}:${ctx.messageId}`;
}

function shouldProcessMessage(ctx: FeishuMessageContext): boolean {
	const now = Date.now();
	const key = buildMessageDedupKey(ctx);
	const seenAt = processedMessages.get(key);
	if (seenAt && now - seenAt < DEDUP_TTL_MS) {
		return false;
	}

	processedMessages.set(key, now);

	for (const [msgKey, ts] of processedMessages) {
		if (now - ts >= DEDUP_TTL_MS) {
			processedMessages.delete(msgKey);
		}
	}

	if (processedMessages.size > DEDUP_MAX_SIZE) {
		const overflow = processedMessages.size - DEDUP_MAX_SIZE;
		let removed = 0;
		for (const msgKey of processedMessages.keys()) {
			processedMessages.delete(msgKey);
			removed++;
			if (removed >= overflow) break;
		}
	}

	return true;
}

function isWorkflowCreateIntent(text: string): boolean {
	const v = text.toLowerCase();
	return (
		v.includes("workflow") ||
		v.includes("工作流") ||
		v.includes("创建") ||
		v.includes("新建") ||
		v.includes("create")
	);
}

function buildFeishuSystemContext(ctx: FeishuMessageContext): string {
	return [
		"Feishu runtime context (trusted):",
		`- source: feishu`,
		`- chat_id: ${ctx.chatId}`,
		`- chat_type: ${ctx.chatType}`,
		`- sender_open_id: ${ctx.senderOpenId ?? ""}`,
		`- sender_user_id: ${ctx.senderUserId ?? ""}`,
		`- sender_union_id: ${ctx.senderUnionId ?? ""}`,
		`- tenant_key: ${ctx.tenantKey ?? ""}`,
	].join("\n");
}

function buildFeishuCapabilityContext(ctx: FeishuMessageContext): string {
	return [
		"## Feishu Source Context",
		"This task is triggered from Feishu message.",
		"If you are creating a workflow that needs user push notifications, use the skill:",
		"- workflows/skills/feishu-bot",
		"You can send text/image/file via scripts/lib.ts from that skill.",
		"Reply to the triggering user/chat using the Feishu runtime context from system messages.",
	].join("\n");
}

function buildWrappedInput(
	userInput: string,
	contextSuffix: string,
	capabilityContext: string,
): string {
	const base = `<user repeat-in=\"en,ja\">\n${userInput}\n</user>`;
	return [contextSuffix, capabilityContext, base].filter(Boolean).join("\n\n");
}

async function runFeishuRound(
	bot: FeishuBot,
	session: FeishuSession,
	userInput: string,
): Promise<void> {
	const renderer = new FeishuRenderer(bot, session.ctx);
	const [existing, schedules] = await Promise.all([
		discoverWorkflows(),
		loadSchedules(),
	]);

	let contextSuffix = "";
	if (existing.length > 0) {
		contextSuffix += `## Existing workflows (reuse if applicable)\n${existing
			.map(
				(w) =>
					`- ${w.name}: ${w.description || "(no description)"} → ${w.path}`,
			)
			.join("\n")}`;
	}
	if (schedules.length > 0) {
		contextSuffix += `${contextSuffix ? "\n\n" : ""}## Existing schedules\n${schedules
			.map(
				(s) =>
					`- ${s.name}: ${s.cron} → ${s.workflow ?? "(delegateTask)"} [${s.enabled ? "enabled" : "disabled"}]`,
			)
			.join("\n")}`;
	}

	const capabilityContext = isWorkflowCreateIntent(userInput)
		? buildFeishuCapabilityContext(session.ctx)
		: "";

	session.history.push({
		type: "user_text",
		content: buildWrappedInput(userInput, contextSuffix, capabilityContext),
	});

	const result = await agentLoop<InteractiveResult>(session.history, {
		maxIterations: 30,
		renderer,
		schema: InteractiveResultSchema,
	});
	session.history = result.history;

	await renderer.drain();

	if (result.result == null) {
		await bot.sendText(
			session.ctx,
			`✗ Agent 异常终止\n${result.report ?? "no report"}`,
		);
		session.history.push({
			type: "user_text",
			content: `Agent terminated without a valid result. Report: ${result.report ?? "none"}\nWaiting for the next task from the user.`,
		});
		return;
	}

	switch (result.result.type) {
		case "chat":
			await bot.sendText(session.ctx, result.result.message);
			session.history.push({
				type: "user_text",
				content:
					"Your submission was accepted (chat). Waiting for the next message from the user.",
			});
			return;
		case "need_info":
			await bot.sendText(session.ctx, `需要更多信息：${result.result.message}`);
			session.history.push({
				type: "user_text",
				content: `Your submission was accepted (need_info). Waiting for the user to provide: ${result.result.message}`,
			});
			return;
		case "completed":
			await bot.sendText(
				session.ctx,
				`✓ 任务完成: ${result.result.result}${
					result.result.summary ? `\n${result.result.summary}` : ""
				}`,
			);
			session.history.push({
				type: "user_text",
				content: `Your submission was accepted (completed). Result: ${result.result.result}\nWaiting for the next task from the user.`,
			});
			return;
		case "error":
			await bot.sendText(session.ctx, `✗ Agent 错误: ${result.result.error}`);
			session.history.push({
				type: "user_text",
				content: `Your submission was accepted (error). Error: ${result.result.error}\nWaiting for the next task or additional info from the user.`,
			});
			return;
	}
}

export async function startFeishuService(): Promise<void> {
	const appId = requireEnv("FEISHU_APP_ID");
	const appSecret = requireEnv("FEISHU_APP_SECRET");
	const encryptKey = process.env.FEISHU_ENCRYPT_KEY;
	const domain = process.env.FEISHU_DOMAIN === "lark" ? "lark" : "feishu";

	const bot = new FeishuBot({ appId, appSecret, domain });
	const systemPrompt = await Bun.file(PROMPT_PATH).text();

	const dispatcher = new lark.EventDispatcher({
		encryptKey,
	}).register({
		"im.message.receive_v1": async (data: any) => {

			console.log("[feishu] received event:", JSON.stringify(data));
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

			console.log(`[feishu] received message: ${text}`);

			const sessionKey = buildSessionKey(ctx);
			const existing = sessions.get(sessionKey);
			const session: FeishuSession =
				existing ??
				({
					history: [
						{ type: "system", content: systemPrompt },
						{ type: "system", content: buildFeishuSystemContext(ctx) },
					],
					ctx,
				} as FeishuSession);

			session.ctx = ctx;
			sessions.set(sessionKey, session);

			console.log(`[feishu] received message: ${text} (sessionKey=${sessionKey})`);

			if (text.toLowerCase() === "exit") {
				sessions.delete(sessionKey);
				await bot.sendText(ctx, "会话已清理。请发送新的任务。");
				return;
			}

			await runFeishuRound(bot, session, text);
		},
	});

	const wsClient = new lark.WSClient({
		appId,
		appSecret,
		domain: domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
		loggerLevel: lark.LoggerLevel.info,
	});

	wsClient.start({
		eventDispatcher: dispatcher,
	});

	console.log("[feishu] long connection mode started (WSClient)");
}

if (import.meta.main) {
	startFeishuService().catch((err) => {
		console.error("[feishu] fatal error:", err);
		process.exit(1);
	});
}
