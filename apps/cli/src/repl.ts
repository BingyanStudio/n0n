/**
 * REPL — 交互式对话循环
 *
 * Ctrl+C 在模型输出时中断当前响应（而非立即终止进程），用户可在中断后继续输入新消息推入对话。
 * 在等待用户输入时，按下 Ctrl+C 会退出 REPL 进程。
 */

import { createInterface } from "node:readline";
import { isTTY, label, RichRenderer, style, writeln } from "@n0n/cli-ui";
import { agentLoop, PlainRenderer } from "@n0n/core";
import { loadSchedules } from "@n0n/scheduler";
import { formatAgentsMdPrompt, loadAgentsMd } from "@n0n/shared";
import type { DomainMessage, SubmitToolResult } from "@n0n/types";
import {
	discoverWorkflows,
	type InteractiveResult,
	InteractiveResultSchema,
	type WorkflowPaths,
} from "@n0n/workflow";
import interactivePromptText from "./prompts/interactive.md" with {
	type: "text",
};

/** CLI 交互模式的用户输入行为引导 — 含 chat 类型 */
const USER_INPUT_HINT = [
	"First, ask yourself: can I answer this by calling \`exec\`, \`write\`, or \`edit\`? If yes — do it, then submit as \`completed\`.",
	"If this is a pure social greeting with nothing actionable (e.g. 你好, 谢谢), submit a \`chat\` response.",
	"Otherwise, reason out what the user needs — start by calling \`reminder\` with your OKR breakdown, then proceed step by step.",
].join("\n");

type ReplContextPaths = Pick<
	WorkflowPaths,
	"workspace" | "tasks" | "skills" | "schedules" | "temp"
>;
/**
 * 构建工作区上下文（注入为 system message），告知 agent cwd 和目录结构。
 * interactive.md 中的 specification 描述了相对路径布局，这里补充实际的绝对路径。
 */
function buildWorkspaceContext(paths: ReplContextPaths): string {
	return [
		"## Workspace Environment",
		"",
		`Your current working directory (cwd) is: \`${paths.workspace}\``,
		"All tool paths resolve relative to this directory:",
		"- `exec` scripts run with cwd = workspace root",
		"- `write` / `edit` relative paths resolve against workspace root",
		"",
		"Use relative paths (e.g. `workflows/tasks/my-task.ts`) — they will resolve correctly.",
	].join("\n");
}
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
	let systemPrompt = interactivePromptText;
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
			// 输入锁定：暂停渲染输出，防止 readline 和渲染器同时写 stderr
			if (renderer instanceof RichRenderer) renderer.pauseOutput();
			rl.question(q, (answer) => {
				if (renderer instanceof RichRenderer) renderer.resumeOutput();
				resolve(answer);
			});
		});
	const confirmFn = (question: string): Promise<string> =>
		new Promise((resolve) => {
			if (closed) return resolve("n");
			rl.question(question, resolve);
		});

	// ── Ctrl+C 中断控制 ──
	let abortController = new AbortController();
	let agentRunning = false;

	// readline 的 SIGINT 事件在 terminal 模式下会自动触发
	// 非 terminal 模式下需要监听 process SIGINT
	if (isTTY) {
		rl.on("SIGINT", () => {
			if (agentRunning) {
				abortController.abort();
			} else {
				// 不在 agent 运行中，正常退出
				rl.close();
			}
		});
	} else {
		process.on("SIGINT", () => {
			if (agentRunning) {
				abortController.abort();
			} else {
				process.exit(0);
			}
		});
	}

	writeln(
		style.bold("n0n") +
			style.gray(` — Natural Language Workflow Engine [${paths.workspace}]`),
	);
	writeln(
		style.gray(
			'输入任务描述，AI 将创建可复用的 workflow。输入 "exit" 退出。Ctrl+C 中断输出。',
		),
	);
	writeln();

	let userInput = initialInput ?? (await prompt(`${label.user()} `));
	let history: DomainMessage[] = [
		{ type: "system", content: systemPrompt },
		{ type: "system", content: buildWorkspaceContext(paths) },
		{
			type: "user_input",
			content: userInput,
			context: await gatherContext(paths),
			capabilities: null,
			hint: USER_INPUT_HINT,
		},
	];

	while (userInput.trim().toLowerCase() !== "exit") {
		abortController = new AbortController();
		agentRunning = true;
		let agentResult: Awaited<ReturnType<typeof agentLoop<InteractiveResult>>>;
		try {
			agentResult = await agentLoop<InteractiveResult>(history, {
				maxIterations: 30,
				renderer,
				confirmFn,
				schema: InteractiveResultSchema,
				signal: abortController.signal,
				toolsWorkspace: { workspace: paths.workspace, tempDir: paths.temp },
			});
		} catch (err) {
			writeln();
			writeln(`${style.red("✗")} Agent 运行出错，已中止本轮对话。`);
			const message =
				err instanceof Error ? err.message : String(err ?? "未知错误");
			writeln(style.gray(`  ${message}`));
			writeln();
			userInput = await prompt(`${label.user()} `);
			history.push({
				type: "user_input",
				content: userInput,
				context: await gatherContext(paths),
				capabilities: null,
				hint: USER_INPUT_HINT,
			});
			continue;
		} finally {
			agentRunning = false;
		}
		history = agentResult.history;

		// ── 被用户中断（通过 AbortController.signal 判断，避免与 submit report 冲突） ──
		if (abortController.signal.aborted) {
			writeln();
			userInput = await prompt(`${label.user()} `);
			history.push({
				type: "user_input",
				content: userInput,
				context: await gatherContext(paths),
				capabilities: null,
				hint: USER_INPUT_HINT,
			});
			continue;
		}

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
				hint: USER_INPUT_HINT,
			});
			continue;
		}

		switch (ir.type) {
			case "chat": {
				writeln(ir.message);
				if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
				writeln();
				userInput = await prompt(`${label.user()} `);
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
					hint: USER_INPUT_HINT,
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
					hint: USER_INPUT_HINT,
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
