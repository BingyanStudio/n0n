/**
 * Round — Agent 对话轮次执行
 *
 * @deprecated 此模块不再维护
 *
 * 负责一次完整的 agent round：
 * 1. 收集上下文（已有工作流、定时任务）
 * 2. 创建 FeishuConversation + FeishuRenderer
 * 3. 调用 agentLoop
 * 4. 根据结果更新卡片和 session history
 */

import { agentLoop } from "@n0n/core";
import { loadSchedules } from "@n0n/scheduler";
import {
	discoverSkills,
	formatAgentsMdPrompt,
	formatSkillSummaries,
	loadAgentsMd,
} from "@n0n/shared";
import {
	discoverWorkflows,
	type InteractiveResult,
	InteractiveResultSchema,
} from "@n0n/workflow";
import type { FeishuBot } from "./bot.ts";
import { FeishuConversation } from "./conversation.ts";
import { FeishuRenderer } from "./renderer.ts";
import type { FeishuSession } from "./session.ts";

// ── 辅助 ──

// ── 主流程 ──

export async function runFeishuRound(
	bot: FeishuBot,
	session: FeishuSession,
	userInput: string,
	abortController: AbortController,
): Promise<void> {
	// 1. 创建会话消息管理器 + 渲染器
	const conv = await FeishuConversation.create(bot, session.ctx);
	const renderer = new FeishuRenderer(conv);
	renderer.userMessage(userInput);

	// 2. 收集上下文
	const [existing, schedules, agentsMd, skills] = await Promise.all([
		discoverWorkflows(false, session.paths),
		loadSchedules(session.paths),
		loadAgentsMd(session.paths.workspace),
		discoverSkills(session.paths.skills),
	]);

	const contextParts: string[] = [];
	if (agentsMd) {
		contextParts.push(formatAgentsMdPrompt(agentsMd));
	}
	if (existing.length > 0) {
		contextParts.push(
			`## Existing workflows (reuse if applicable)\n${existing
				.map(
					(w) =>
						`- ${w.name}: ${w.description || "(no description)"} → ${w.path}`,
				)
				.join("\n")}`,
		);
	}
	if (schedules.length > 0) {
		contextParts.push(
			`## Existing schedules\n${schedules
				.map(
					(s) =>
						`- ${s.name}: ${s.cron} → ${s.workflow ?? "(delegateTask)"} [${s.enabled ? "enabled" : "disabled"}]`,
				)
				.join("\n")}`,
		);
	}
	if (skills.length > 0) {
		contextParts.push(
			`## Available Skills (shared, read-only)\n${formatSkillSummaries(skills)}`,
		);
	}

	session.history.push({
		type: "user_input",
		content: userInput,
		context: contextParts.length > 0 ? contextParts.join("\n\n") : null,
		hint: null,
	});

	// 3. 执行 agent loop（传入 per-user workspace 隔离 exec cwd/temp）
	const result = await agentLoop<InteractiveResult>(session.history, {
		maxIterations: 30,
		renderer,
		schema: InteractiveResultSchema,
		signal: abortController.signal,
		toolsWorkspace: {
			workspace: session.paths.workspace,
			tempDir: session.paths.temp,
		},
	});

	if (abortController.signal.aborted) {
		conv.finish("✋ 任务已中断", "orange", "任务被用户中断。");
		await renderer.drain();
		return;
	}

	session.history = result.history;
	await renderer.drain();

	// 4. 根据结果更新卡片 + history feedback
	if (result.result == null) {
		conv.finish("❌ Agent 异常终止", "red", result.report ?? "no report");
		await renderer.drain();
		session.history.push({
			type: "turn_feedback",
			status: "rejected",
			resultType: "terminated",
			detail: result.report ?? "none",
		});
		return;
	}

	switch (result.result.type) {
		case "chat":
			conv.finish("💬 回复", "blue", result.result.message);
			await renderer.drain();
			session.history.push({
				type: "turn_feedback",
				status: "accepted",
				resultType: "chat",
				detail: "Waiting for the next message from the user.",
			});
			return;

		case "need_info":
			conv.finish("❓ 需要更多信息", "yellow", result.result.message);
			await renderer.drain();
			session.history.push({
				type: "turn_feedback",
				status: "accepted",
				resultType: "need_info",
				detail: `Waiting for the user to provide: ${result.result.message}`,
			});
			return;

		case "completed":
			conv.finish(
				"✅ 任务完成",
				"green",
				`${result.result.result}${result.result.summary ? `\n${result.result.summary}` : ""}`,
			);
			await renderer.drain();
			session.history.push({
				type: "turn_feedback",
				status: "accepted",
				resultType: "completed",
				detail: `Result: ${result.result.result}\nWaiting for the next task from the user.`,
			});
			return;

		case "error":
			conv.finish("❌ Agent 错误", "red", result.result.error);
			await renderer.drain();
			session.history.push({
				type: "turn_feedback",
				status: "accepted",
				resultType: "error",
				detail: `Error: ${result.result.error}\nWaiting for the next task or additional info from the user.`,
			});
			return;

		default: {
			const _exhaustive: never = result.result;
			console.warn(
				`[feishu] unhandled result type: ${(_exhaustive as any).type}`,
			);
		}
	}
}
