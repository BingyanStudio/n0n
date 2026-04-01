/**
 * Commands — 飞书斜杠命令解析与处理
 *
 * 解析 /help, /exit, /reset, /id, /crons, /workflows 等命令，
 * 并执行对应操作。
 */

import { loadSchedules, setScheduleEnabled } from "@n0n/scheduler";
import { discoverWorkflows, runWorkflow } from "@n0n/workflow";
import type { FeishuBot, FeishuMessageContext } from "./bot.ts";
import {
	buildCronListCard,
	buildTextCard,
	buildWorkflowListCard,
	type CronItem,
	chunkText,
} from "./cards/index.ts";
import type { FeishuSession } from "./session.ts";
import {
	abortSessionsByUser,
	resetSession,
	resetSessionsByUser,
} from "./session.ts";

// ── 命令类型 ──

export type FeishuCommand =
	| { type: "help" }
	| { type: "exit" }
	| { type: "reset" }
	| { type: "id" }
	| { type: "crons_list" }
	| { type: "crons_toggle"; enabled: boolean; name: string }
	| { type: "workflows_list" }
	| { type: "workflows_run"; name: string; argsRaw: string | null }
	| { type: "workflows_show"; name: string };

/** 菜单事件允许的简单命令类型（无额外参数的命令） */
type SimpleCommandType =
	| "help"
	| "exit"
	| "reset"
	| "id"
	| "crons_list"
	| "workflows_list";

const MENU_COMMAND_TYPES: ReadonlySet<string> = new Set<SimpleCommandType>([
	"help",
	"exit",
	"reset",
	"id",
	"crons_list",
	"workflows_list",
]);

/**
 * 解析飞书菜单事件的 event_key 为命令（运行时校验，不使用 as 断言）
 */
export function parseMenuCommand(
	eventKey: string | undefined,
): FeishuCommand | null {
	if (!eventKey || !MENU_COMMAND_TYPES.has(eventKey)) return null;
	// 运行时已校验 eventKey 在合法集合中，此处断言是安全的类型收窄
	return { type: eventKey as SimpleCommandType };
}

// ── 解析 ──

export function parseCommand(text: string): FeishuCommand | null {
	const t = text.trim();
	if (!t.startsWith("/")) return null;

	if (/^\/help$/i.test(t)) return { type: "help" };
	if (/^\/exit$/i.test(t)) return { type: "exit" };
	if (/^\/reset$/i.test(t)) return { type: "reset" };
	if (/^\/id$/i.test(t)) return { type: "id" };
	if (/^\/crons$/i.test(t)) return { type: "crons_list" };

	const cronToggle = t.match(/^\/crons\s+(enable|disable)\s+(.+)$/i);
	if (cronToggle) {
		return {
			type: "crons_toggle",
			enabled: cronToggle[1]?.toLowerCase() === "enable",
			name: (cronToggle[2] ?? "").trim(),
		};
	}

	if (/^\/workflows$/i.test(t)) return { type: "workflows_list" };

	const wfShow = t.match(/^\/workflows\s+show\s+(.+)$/i);
	if (wfShow) {
		return { type: "workflows_show", name: (wfShow[1] ?? "").trim() };
	}

	const wfRun = t.match(/^\/workflows\s+run\s+(\S+)(?:\s+(.+))?$/i);
	if (wfRun) {
		return {
			type: "workflows_run",
			name: (wfRun[1] ?? "").trim(),
			argsRaw: wfRun[2]?.trim() ?? null,
		};
	}

	return null;
}

// ── 处理 ──

export async function handleCommand(
	cmd: FeishuCommand,
	bot: FeishuBot,
	sessionKey: string,
	session: FeishuSession,
	systemPrompt: string,
): Promise<void> {
	const ctx = session.ctx;

	switch (cmd.type) {
		case "help":
			await sendText(bot, ctx, "帮助", HELP_TEXT);
			return;

		case "exit":
			// 菜单事件无 chatId，需按用户 ID 查找并中断所有任务
			if (!ctx.chatId && ctx.senderOpenId) {
				const aborted = abortSessionsByUser(ctx.senderOpenId);
				await sendText(
					bot,
					ctx,
					"已退出",
					aborted > 0
						? `✋ 已中断 ${aborted} 个任务。`
						: "✋ 当前没有正在执行的任务。",
				);
			} else {
				if (session.currentTask) {
					session.currentTask.abortController.abort();
					session.currentTask = null;
				}
				await sendText(bot, ctx, "已退出", "✋ 当前任务已中断。");
			}
			return;

		case "reset":
			// 菜单事件无 chatId，sessionKey 为 "unknown:ou_xxx"，
			// 需要按用户 ID 查找并重置所有真实会话
			if (!ctx.chatId && ctx.senderOpenId) {
				const count = resetSessionsByUser(ctx.senderOpenId, systemPrompt);
				await sendText(
					bot,
					ctx,
					"已重置",
					count > 0
						? `🔄 已重置 ${count} 个会话。`
						: "🔄 没有找到活跃会话，已就绪。",
				);
			} else {
				if (session.currentTask) {
					session.currentTask.abortController.abort();
					session.currentTask = null;
				}
				resetSession(sessionKey, ctx, systemPrompt, session.paths);
				await sendText(bot, ctx, "已重置", "🔄 会话已重置。");
			}
			return;

		case "id":
			await sendText(
				bot,
				ctx,
				"身份信息",
				[
					`**chat_id:** ${ctx.chatId}`,
					`**chat_type:** ${ctx.chatType}`,
					`**sender_open_id:** ${ctx.senderOpenId}`,
					`**sender_user_id:** ${ctx.senderUserId ?? "N/A"}`,
					`**tenant_key:** ${ctx.tenantKey ?? "N/A"}`,
				].join("\n"),
			);
			return;

		case "crons_list": {
			const schedules = await loadSchedules(session.paths);
			const crons: CronItem[] = schedules.map((s) => ({
				name: s.name,
				cron: s.cron,
				prompt: s.prompt,
				enabled: s.enabled,
			}));
			const card = buildCronListCard(crons);
			await bot.createCardMessage(ctx, card);
			return;
		}

		case "crons_toggle": {
			const ok = await setScheduleEnabled(cmd.name, cmd.enabled, session.paths);
			await sendText(
				bot,
				ctx,
				"定时任务",
				ok
					? `✅ ${cmd.name} 已${cmd.enabled ? "启用" : "禁用"}`
					: `❌ 未找到: ${cmd.name}`,
			);
			return;
		}

		case "workflows_list": {
			const workflows = await discoverWorkflows(false, session.paths);
			const items = workflows.map((w) => ({
				name: w.name,
				description: w.description || "(no description)",
				path: w.path,
			}));
			const card = buildWorkflowListCard(items);
			await bot.createCardMessage(ctx, card);
			return;
		}

		case "workflows_show": {
			const workflows = await discoverWorkflows(false, session.paths);
			const wf = workflows.find((w) => w.name === cmd.name);
			if (!wf) {
				await sendText(bot, ctx, "工作流", `❌ 未找到: ${cmd.name}`);
				return;
			}
			const info = [
				`**名称:** ${wf.name}`,
				`**描述:** ${wf.description || "(none)"}`,
				`**路径:** ${wf.path}`,
			].join("\n");
			await sendText(bot, ctx, `工作流: ${wf.name}`, info);
			return;
		}

		case "workflows_run": {
			const workflows = await discoverWorkflows(false, session.paths);
			const wf = workflows.find((w) => w.name === cmd.name);
			if (!wf) {
				await sendText(bot, ctx, "工作流", `❌ 未找到: ${cmd.name}`);
				return;
			}
			await sendText(bot, ctx, "工作流", `⏳ 正在执行: ${cmd.name}...`);
			try {
				const result = await runWorkflow(
					wf.path,
					cmd.argsRaw ?? undefined,
					session.paths.workspace,
				);
				await sendText(
					bot,
					ctx,
					`工作流完成: ${cmd.name}`,
					`✅ ${JSON.stringify(result, null, 2)}`,
				);
			} catch (err) {
				await sendText(
					bot,
					ctx,
					`工作流失败: ${cmd.name}`,
					`❌ ${String(err)}`,
				);
			}
			return;
		}
	}
}

// ── 辅助 ──

const HELP_TEXT = [
	"**可用命令：**",
	"`/help` — 显示帮助",
	"`/exit` — 中断当前任务",
	"`/reset` — 重置会话",
	"`/id` — 显示身份信息",
	"`/crons` — 列出定时任务",
	"`/crons enable|disable <name>` — 启用/禁用定时任务",
	"`/workflows` — 列出工作流",
	"`/workflows show <name>` — 查看工作流详情",
	"`/workflows run <name> [args]` — 执行工作流",
	"",
	"直接发送文本即可与 Agent 对话。",
].join("\n");

async function sendText(
	bot: FeishuBot,
	ctx: FeishuMessageContext,
	title: string,
	text: string,
): Promise<void> {
	const chunks = chunkText(text, 1800);
	for (const chunk of chunks) {
		const card = buildTextCard(title, chunk);
		await bot.createCardMessage(ctx, card);
	}
}
