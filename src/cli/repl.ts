/**
 * REPL — 交互式对话循环
 *
 * 管理 readline、对话历史、agent 调用和结果展示。
 * Prompt 模板和 schema 从外部注入，保持 REPL 逻辑纯粹。
 */

import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { agentLoop } from "../agent/loop.ts";
import { loadSchedules } from "../scheduler/index.ts";
import type { DomainMessage } from "../types/domain.ts";
import { isTTY, label, style, writeln } from "../ui/ansi.ts";
import { PlainRenderer } from "../ui/renderer.ts";
import { RichRenderer } from "../ui/rich-renderer.ts";
import { discoverWorkflows } from "../workflow/index.ts";
import {
	InteractiveResultSchema,
	type InteractiveResult,
} from "./schema.ts";

const PROMPT_PATH = resolve(import.meta.dir, "prompts/interactive.md");

/**
 * 启动交互式 REPL
 */
export async function startRepl(initialInput?: string): Promise<void> {
	const systemPrompt = await Bun.file(PROMPT_PATH).text();
	const renderer = isTTY ? new RichRenderer() : new PlainRenderer();

	const rl = createInterface({
		input: process.stdin,
		output: process.stderr,
		terminal: isTTY,
	});

	let closed = false;
	rl.on("close", () => {
		closed = true;
	});

	const prompt = (q: string): Promise<string> =>
		new Promise((resolve) => {
			if (closed) return resolve("exit");
			rl.question(q, resolve);
		});

	const confirmFn = (question: string): Promise<string> =>
		new Promise((resolve) => {
			if (closed) return resolve("n");
			rl.question(question, resolve);
		});

	writeln(
		style.bold("n0n") + style.gray(" — Natural Language Workflow Engine"),
	);
	writeln(
		style.gray('输入任务描述，AI 将创建可复用的 workflow。输入 "exit" 退出。'),
	);
	writeln();

	let userInput = initialInput ?? (await prompt(`${label.user()} `));
	let history: DomainMessage[] = [];

	while (userInput.trim() !== "exit") {
		if (!userInput.trim()) {
			userInput = await prompt(`${label.user()} `);
			continue;
		}

		// 主动推送已有 workflow + schedule 列表
		const [existing, schedules] = await Promise.all([
			discoverWorkflows(),
			loadSchedules(),
		]);
		let contextSuffix = "";
		if (existing.length > 0) {
			contextSuffix += `\n\n## Existing workflows (reuse if applicable)\n${existing.map((w) => `- ${w.name}: ${w.description || "(no description)"} → ${w.path}`).join("\n")}`;
		}
		if (schedules.length > 0) {
			contextSuffix += `\n\n## Existing schedules\n${schedules.map((s) => `- ${s.name}: ${s.cron} → ${s.workflow ?? "(delegateTask)"} [${s.enabled ? "enabled" : "disabled"}]`).join("\n")}`;
		}

		// 首轮：新建 history；后续轮：追加用户消息到已有 history
		const wrappedInput = contextSuffix
			? `${contextSuffix}\n\n<user repeat-in="en,ja">\n${userInput}\n</user>`
			: `<user repeat-in="en,ja">\n${userInput}\n</user>`;

		if (history.length === 0) {
			history = [
				{ type: "system", content: systemPrompt },
				{ type: "user_text", content: wrappedInput },
			];
		} else {
			history.push({ type: "user_text", content: wrappedInput });
		}

		const agentResult = await agentLoop<InteractiveResult>(history, {
			maxIterations: 30,
			renderer,
			confirmFn,
			schema: InteractiveResultSchema,
		});
		// 保留 agent 产出的完整历史，下轮继续
		history = agentResult.history;

		const ir = agentResult.result;
		writeln();

		// ── 按结果类型分别展示 ──

		if (ir == null) {
			writeln(`${style.red("✗")} Agent 异常终止`);
			if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
			history.push({
				type: "user_text",
				content: `Agent terminated without a valid result. Report: ${agentResult.report ?? "none"}\nWaiting for the next task from the user.`,
			});
			writeln();
			writeln(style.gray("继续输入新任务，或输入 'exit' 退出:"));
			writeln();
			userInput = await prompt(`${label.user()} `);
			continue;
		}

		switch (ir.type) {
			case "chat": {
				writeln(ir.message);
				if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
				history.push({
					type: "user_text",
					content:
						"Your submission was accepted (chat). Waiting for the next message from the user.",
				});
				writeln();
				userInput = await prompt(`${label.user()} `);
				continue;
			}

			case "need_info": {
				writeln(`${style.yellow("?")} Agent 需要更多信息:`);
				writeln(`  ${ir.message}`);
				if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
				history.push({
					type: "user_text",
					content: `Your submission was accepted (need_info). Waiting for the user to provide: ${ir.message}`,
				});
				writeln();
				writeln(style.gray("请补充信息，或输入 'exit' 退出:"));
				writeln();
				userInput = await prompt(`${label.user()} `);
				continue;
			}

			case "completed": {
				writeln(`${style.green("✓")} 任务完成: ${ir.result}`);
				if (ir.summary) writeln(style.gray(`  ${ir.summary}`));
				if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
				history.push({
					type: "user_text",
					content: `Your submission was accepted (completed). Result: ${ir.result}\nWaiting for the next task from the user.`,
				});
				writeln();
				writeln(style.gray("继续输入新任务，或输入 'exit' 退出:"));
				writeln();
				userInput = await prompt(`${label.user()} `);
				break;
			}

			case "error": {
				writeln(`${style.red("✗")} Agent 报告错误:`);
				writeln(`  ${ir.error}`);
				if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
				history.push({
					type: "user_text",
					content: `Your submission was accepted (error). Error: ${ir.error}\nWaiting for the next task or additional info from the user.`,
				});
				writeln();
				writeln(style.gray("可以补充信息重试，或输入 'exit' 退出:"));
				writeln();
				userInput = await prompt(`${label.user()} `);
				continue;
			}
		}
	}

	rl.close();
	writeln(style.gray("Bye!"));
}
