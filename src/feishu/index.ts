import * as lark from "@larksuiteoapi/node-sdk";
import { fileURLToPath } from "node:url";
import { agentLoop } from "../agent/loop.ts";
import { InteractiveResultSchema, type InteractiveResult } from "../cli/schema.ts";
import { discoverWorkflows } from "../discovery.ts";
import { loadSchedules, setScheduleEnabled } from "../scheduler/index.ts";
import type { DomainMessage } from "../types/domain.ts";
import { runWorkflow } from "../workflow/index.ts";
import { FeishuBot, type FeishuMessageContext } from "./bot.ts";
import { FeishuConversationMessages, FeishuRenderer } from "./renderer.ts";

const PROMPT_PATH = fileURLToPath(
	new URL("../cli/prompts/interactive.md", import.meta.url),
);

interface FeishuSession {
	history: DomainMessage[];
	ctx: FeishuMessageContext;
	currentTask: {
		abortController: AbortController;
		startedAt: number;
	} | null;
}

type FeishuCommand =
	| { type: "help" }
	| { type: "exit" }
	| { type: "reset" }
	| { type: "id" }
	| { type: "crons_list" }
	| { type: "crons_toggle"; enabled: boolean; name: string }
	| { type: "workflows_list" }
	| { type: "workflows_run"; name: string; argsRaw: string | null }
	| { type: "workflows_show"; name: string };

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
	return [ctx.chatId ?? "unknown", ctx.senderOpenId ?? ctx.senderUserId ?? "unknown"].join(":");
}

function buildMessageDedupKey(ctx: FeishuMessageContext): string {
	return `${ctx.chatId}:${ctx.messageId}`;
}

function shouldProcessMessage(ctx: FeishuMessageContext): boolean {
	const now = Date.now();
	const key = ctx.messageId!;
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

function createInitialHistory(
	systemPrompt: string,
	ctx: FeishuMessageContext,
): DomainMessage[] {
	return [
		{ type: "system", content: systemPrompt },
		{ type: "system", content: buildFeishuSystemContext(ctx) },
	];
}

function getOrCreateSession(
	sessionKey: string,
	ctx: FeishuMessageContext,
	systemPrompt: string,
): FeishuSession {
	const existing = sessions.get(sessionKey);
	if (existing) {
		existing.ctx = ctx;
		return existing;
	}

	const session: FeishuSession = {
		history: createInitialHistory(systemPrompt, ctx),
		ctx,
		currentTask: null,
	};
	sessions.set(sessionKey, session);
	return session;
}

function parseCommand(text: string): FeishuCommand | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;

	if (/^\/help$/i.test(trimmed)) return { type: "help" };
	if (/^\/exit$/i.test(trimmed)) return { type: "exit" };
	if (/^\/reset$/i.test(trimmed)) return { type: "reset" };
	if (/^\/id$/i.test(trimmed)) return { type: "id" };

	if (/^\/crons$/i.test(trimmed)) {
		return { type: "crons_list" };
	}
	const cronToggleMatch = trimmed.match(/^\/crons\s+(enable|disable)\s+(.+)$/i);
	if (cronToggleMatch) {
		return {
			type: "crons_toggle",
			enabled: cronToggleMatch[1]?.toLowerCase() === "enable",
			name: (cronToggleMatch[2] ?? "").trim(),
		};
	}

	if (/^\/workflows$/i.test(trimmed)) {
		return { type: "workflows_list" };
	}
	const wfShowMatch = trimmed.match(/^\/workflows\s+show\s+(.+)$/i);
	if (wfShowMatch) {
		return {
			type: "workflows_show",
			name: (wfShowMatch[1] ?? "").trim(),
		};
	}
	const wfRunMatch = trimmed.match(/^\/workflows\s+run\s+(\S+)(?:\s+([\s\S]+))?$/i);
	if (wfRunMatch) {
		return {
			type: "workflows_run",
			name: (wfRunMatch[1] ?? "").trim(),
			argsRaw: wfRunMatch[2]?.trim() ?? null,
		};
	}

	return null;
}

function parseWorkflowArgs(raw: string | null): unknown {
	if (!raw) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

function splitText(text: string, maxLen: number): string[] {
	const chunks: string[] = [];
	let cursor = 0;
	while (cursor < text.length) {
		chunks.push(text.slice(cursor, cursor + maxLen));
		cursor += maxLen;
	}
	return chunks.length > 0 ? chunks : [""];
}

async function sendWorkflowAsCodeBlock(
	bot: FeishuBot,
	ctx: FeishuMessageContext,
	name: string,
	content: string,
): Promise<void> {
	const escaped = content.replaceAll("```", "`\u200b``");
	const chunks = splitText(escaped, 1400);
	for (const chunk of chunks) {
		await bot.sendText(ctx, `工作流展示`, `文件名称：${name}\n\`\`\`javascript\n${chunk}\n\`\`\``);
	}
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

async function handleCommand(
	command: FeishuCommand,
	bot: FeishuBot,
	sessionKey: string,
	session: FeishuSession,
	systemPrompt: string,
): Promise<boolean> {
	switch (command.type) {
		case "help": {
			await bot.sendText(
				session.ctx,
				"命令帮助",
				[
					"可用命令：",
					"- /help 查看命令帮助",
					"- /exit 打断当前任务并退出会话",
					"- /reset 清空历史消息记录",
					"- /crons 查看所有 cron 任务（含开启/关闭）",
					"- /crons enable {name} 开启某个 cron 任务",
					"- /crons disable {name} 关闭某个 cron 任务",
					"- /workflows 查看所有 workflow",
					"- /workflows run {name} {args} 运行 workflow（args 可为 JSON 或普通字符串）",
					"- /workflows show {name} 以代码块展示 workflow 文件",
					"- /id 获取你的 user_id / open_id / union_id",
				].join("\n"),
			);
			return true;
		}
		case "exit": {
			if (session.currentTask) {
				session.currentTask.abortController.abort("/exit");
			}
			sessions.delete(sessionKey);
			await bot.sendText(session.ctx, "工作状态", "已打断当前任务并退出会话。请发送新任务开始。");
			return true;
		}
		case "reset": {
			if (session.currentTask) {
				session.currentTask.abortController.abort("/reset");
				session.currentTask = null;
			}
			session.history = createInitialHistory(systemPrompt, session.ctx);
			await bot.sendText(session.ctx, "清空历史", "历史消息已清空。");
			return true;
		}
		case "id": {
			await bot.sendText(
				session.ctx,
				"身份信息",
				[
					"你的身份信息：",
					`- user_id: ${session.ctx.senderUserId ?? "(empty)"}`,
					`- open_id: ${session.ctx.senderOpenId ?? "(empty)"}`,
					`- union_id: ${session.ctx.senderUnionId ?? "(empty)"}`,
					`- chat_id: ${session.ctx.chatId}`,
				].join("\n"),
			);
			return true;
		}
		case "crons_list": {
			const schedules = await loadSchedules();
			if (schedules.length === 0) {
				await bot.sendText(session.ctx, "Cron 任务列表", "当前没有 cron 任务。");
				return true;
			}
			const lines = schedules.map(
				(schedule) =>
					`- [${schedule.enabled ? "enabled" : "disabled"}] ${schedule.name} | ${schedule.cron} | ${schedule.workflow ?? "delegateTask"}`,
			);
			await bot.sendText(session.ctx, "Cron 任务列表", `${lines.join("\n")}`);
			return true;
		}
		case "crons_toggle": {
			const updated = await setScheduleEnabled(command.name, command.enabled);
			if (!updated) {
				await bot.sendText(session.ctx, "Cron 控制", `未找到 cron 任务：${command.name}`);
				return true;
			}
			await bot.sendText(
				session.ctx,
				"Cron 控制",
				`${command.enabled ? "已开启" : "已关闭"} cron 任务：${updated.name}`,
			);
			return true;
		}
		case "workflows_list": {
			const workflows = await discoverWorkflows();
			if (workflows.length === 0) {
				await bot.sendText(session.ctx, "工作流列表", "当前没有可用 workflow。");
				return true;
			}
			const lines = workflows.map(
				(wf) => `- ${wf.name}${wf.description ? `: ${wf.description}` : ""}`,
			);
			await bot.sendText(session.ctx, "工作流列表", `${lines.join("\n")}`);
			return true;
		}
		case "workflows_run": {
			const workflows = await discoverWorkflows();
			const wf = workflows.find((item) => item.name === command.name);
			if (!wf) {
				await bot.sendText(session.ctx, "工作流运行", `未找到 workflow：${command.name}`);
				return true;
			}
			const args = parseWorkflowArgs(command.argsRaw);
			const result = await runWorkflow(wf.path, args);
			await bot.sendText(
				session.ctx,
				"工作流运行",
				`工作流已运行：${wf.name}\n\`\`\`json\n${safeJson(result)}\n\`\`\``,
			);
			return true;
		}
		case "workflows_show": {
			const workflows = await discoverWorkflows("workflows", false);
			const wf = workflows.find((item) => item.name === command.name);
			if (!wf) {
				await bot.sendText(session.ctx, "工作流展示", `未找到 workflow：${command.name}`);
				return true;
			}
			const content = await Bun.file(wf.path).text();
			await sendWorkflowAsCodeBlock(bot, session.ctx, wf.name, content);
			return true;
		}
		default: {
			await bot.sendText(
				session.ctx,
				"未知命令",
				`收到未知命令类型：${String((command as { type?: unknown }).type)}`,
			);
			return true;
		}
	}
}

async function runFeishuRound(
	bot: FeishuBot,
	session: FeishuSession,
	userInput: string,
	abortController: AbortController,
): Promise<void> {
	const conversation = await FeishuConversationMessages.create(bot, session.ctx);
	const renderer = new FeishuRenderer(conversation);
	renderer.userMessage(userInput);
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
		signal: abortController.signal,
	});
	if (abortController.signal.aborted) {
		conversation.setSummary("📌 总结\n✋ 任务已中断");
		await renderer.drain();
		return;
	}
	session.history = result.history;

	await renderer.drain();

	if (result.result == null) {
		conversation.setSummary(
			`📌 总结\n✗ Agent 异常终止\n${result.report ?? "no report"}`,
		);
		await renderer.drain();
		session.history.push({
			type: "user_text",
			content: `Agent terminated without a valid result. Report: ${result.report ?? "none"}\nWaiting for the next task from the user.`,
		});
		return;
	}

	switch (result.result.type) {
		case "chat":
			conversation.setSummary(`📌 总结\n💬 ${result.result.message}`);
			await renderer.drain();
			session.history.push({
				type: "user_text",
				content:
					"Your submission was accepted (chat). Waiting for the next message from the user.",
			});
			return;
		case "need_info":
			conversation.setSummary(`📌 总结\n需要更多信息：${result.result.message}`);
			await renderer.drain();
			session.history.push({
				type: "user_text",
				content: `Your submission was accepted (need_info). Waiting for the user to provide: ${result.result.message}`,
			});
			return;
		case "completed":
			conversation.setSummary(
				`📌 总结\n✓ 任务完成: ${result.result.result}${
					result.result.summary ? `\n${result.result.summary}` : ""
				}`,
			);
			await renderer.drain();
			session.history.push({
				type: "user_text",
				content: `Your submission was accepted (completed). Result: ${result.result.result}\nWaiting for the next task from the user.`,
			});
			return;
		case "error":
			conversation.setSummary(`📌 总结\n✗ Agent 错误: ${result.result.error}`);
			await renderer.drain();
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

			console.log(`[feishu] received message: ${text} (sessionKey=${sessionKey})`);

			const command = parseCommand(text);
			if (command) {
				await handleCommand(command, bot, sessionKey, session, systemPrompt);
				return;
			}

			if (session.currentTask) {
				const elapsedSec = Math.floor(
					(Date.now() - session.currentTask.startedAt) / 1000,
				);
				await bot.sendText(
					ctx,
					"当前任务仍在执行中",
					`当前任务仍在执行中（${elapsedSec}s）。发送 /exit 可打断并退出。`,
				);
				return;
			}

			const abortController = new AbortController();
			session.currentTask = {
				abortController,
				startedAt: Date.now(),
			};

			runFeishuRound(bot, session, text, abortController)
				.catch(async (err) => {
					if (abortController.signal.aborted) return;
					console.error("[feishu] runFeishuRound error:", err);
					await bot.sendText(ctx, "任务执行失败", `任务执行失败：${String(err)}`);
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

			console.log(`[feishu] received message: ${data?.event_key} (sessionKey=${sessionKey})`);
			await handleCommand({ type: data?.event_key }, bot, sessionKey, session, systemPrompt);			
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
