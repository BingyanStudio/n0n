/**
 * REPL — 交互式对话循环
 */

import { createInterface } from "node:readline";
import { isTTY, label, RichRenderer, style, writeln } from "@n0n/cli-ui";
// PlainRenderer for non-TTY — import from core
import {
	agentLoop,
	discoverWorkflows,
	formatAgentsMdPrompt,
	INTERACTIVE_PROMPT_PATH,
	type InteractiveResult,
	InteractiveResultSchema,
	loadAgentsMd,
	loadSchedules,
	PlainRenderer,
	type WorkspacePaths,
} from "@n0n/core";
import type { DomainMessage, SubmitToolResult } from "@n0n/types";

const PROMPT_PATH = INTERACTIVE_PROMPT_PATH;
type ReplContextPaths = Pick<
	WorkspacePaths,
	"workspace" | "tasks" | "skills" | "schedules"
>;

/** 获取当前环境上下文（workflows + schedules），每次调用时重新扫描 */
async function gatherContext(paths: ReplContextPaths): Promise<string | null> {
	const [existing, schedules] = await Promise.all([
		discoverWorkflows(false, paths),
		loadSchedules(paths),
	]);
	const parts: string[] = [];
	if (existing.length > 0) {
		const list = existing
			.map(
				(w) =>
					`- ${w.name}: ${w.description || "(no description)"} → ${w.path}`,
			)
			.join("\n");
		parts.push(`<workflows>\n${list}\n</workflows>`);
	}
	if (schedules.length > 0) {
		const list = schedules
			.map(
				(s) =>
					`- ${s.name}: ${s.cron} → ${s.workflow ?? "(delegateTask)"} [${s.enabled ? "enabled" : "disabled"}]`,
			)
			.join("\n");
		parts.push(`<schedules>\n${list}\n</schedules>`);
	}
	return parts.length > 0 ? parts.join("\n") : null;
}

export async function startRepl(
	paths: ReplContextPaths,
	initialInput?: string,
): Promise<void> {
	let systemPrompt = await Bun.file(PROMPT_PATH).text();
	const agentsMd = await loadAgentsMd(paths.workspace);
	if (agentsMd) {
		systemPrompt += `\n\n${formatAgentsMdPrompt(agentsMd)}`;
	}
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
	let history: DomainMessage[] = [
		{ type: "system", content: systemPrompt },
		{
			type: "user_input",
			content: userInput,
			context: await gatherContext(paths),
			capabilities: null,
		},
	];

	while (userInput.trim().toLowerCase() !== "exit") {
		const agentResult = await agentLoop<InteractiveResult>(history, {
			maxIterations: 30,
			renderer,
			confirmFn,
			schema: InteractiveResultSchema,
		});
		history = agentResult.history;

		const ir = agentResult.result;
		writeln();

		if (ir == null) {
			writeln(`${style.red("✗")} Agent 异常终止`);
			if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
			writeln();
			writeln(style.gray("继续输入新任务，或输入 'exit' 退出:"));
			writeln();
			userInput = await prompt(`${label.user()} `);
			history.push({
				type: "user_input",
				content: userInput,
				context: await gatherContext(paths),
				capabilities: null,
			});
			continue;
		}

		switch (ir.type) {
			case "chat": {
				writeln(ir.message);
				if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
				writeln();
				userInput = await prompt(`${label.user()} `);
				// 用户回答注入到 submit 的 tool result 中，而非作为新的 user 消息
				injectUserResponse(history, userInput);
				continue;
			}

			case "need_info": {
				writeln(`${style.yellow("?")} Agent 需要更多信息:`);
				writeln(`  ${ir.message}`);
				if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
				writeln();
				writeln(style.gray("请补充信息，或输入 'exit' 退出:"));
				writeln();
				userInput = await prompt(`${label.user()} `);
				// 用户回答注入到 submit 的 tool result 中，而非作为新的 user 消息
				injectUserResponse(history, userInput);
				continue;
			}

			case "completed": {
				writeln(`${style.green("✓")} 任务完成: ${ir.result}`);
				if (ir.summary) writeln(style.gray(`  ${ir.summary}`));
				if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
				writeln();
				writeln(style.gray("继续输入新任务，或输入 'exit' 退出:"));
				writeln();
				userInput = await prompt(`${label.user()} `);
				history.push({
					type: "user_input",
					content: userInput,
					context: await gatherContext(paths),
					capabilities: null,
				});
				break;
			}

			case "error": {
				writeln(`${style.red("✗")} Agent 报告错误:`);
				writeln(`  ${ir.error}`);
				if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
				writeln();
				writeln(style.gray("继续输入新任务，或输入 'exit' 退出:"));
				writeln();
				userInput = await prompt(`${label.user()} `);
				history.push({
					type: "user_input",
					content: userInput,
					context: await gatherContext(paths),
					capabilities: null,
				});
				break;
			}
		}
	}

	rl.close();
	writeln(style.gray("Bye!"));
}

function injectUserResponse(history: DomainMessage[], response: string): void {
	for (let i = history.length - 1; i >= 0; i--) {
		const msg = history[i];
		if (
			msg !== undefined &&
			msg.type === "tool_result" &&
			"tool" in msg &&
			msg.tool === "submit"
		) {
			(msg as SubmitToolResult).userResponse = response;
			return;
		}
	}
}
