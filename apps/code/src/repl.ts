/**
 * Code REPL — 代码编写场景的交互循环
 *
 * 与 cli REPL 的区别：
 * - System prompt 为 code.md（代码 agent 而非 workflow builder）
 * - Submit schema 为 CodeResultSchema（completed/need_info/error）
 * - Context 注入项目结构和 git 状态，而非 workflow 列表
 */

import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { isTTY, label, RichRenderer, style, writeln } from "@n0n/cli-ui";
import {
	agentLoop,
	formatAgentsMdPrompt,
	loadAgentsMd,
	PlainRenderer,
	type WorkspacePaths,
} from "@n0n/core";
import type { DomainMessage, SubmitToolResult } from "@n0n/types";
import { type CodeResult, CodeResultSchema } from "./schema.ts";

const PROMPT_PATH = resolve(import.meta.dir, "prompts", "code.md");
type CodeWorkspacePaths = Pick<WorkspacePaths, "workspace" | "temp">;

/**
 * 构建工作区上下文（注入为 system message），告知 agent cwd 和路径解析规则。
 */
function buildWorkspaceContext(workspace: string): string {
	return [
		"## Workspace Environment",
		"",
		`Your current working directory (cwd) is: \`${workspace}\``,
		"All tool paths resolve relative to this directory:",
		"- `exec` scripts run with cwd = workspace root (the project directory)",
		"- `write` / `edit` relative paths resolve against workspace root",
		"",
		"Use relative paths (e.g. `src/utils.ts`) — they will resolve correctly.",
		"Read existing code before modifying it to understand project structure.",
	].join("\n");
}

/** 获取项目上下文（git status + 目录结构） */
async function gatherContext(workspace: string): Promise<string | null> {
	const parts: string[] = [];
	try {
		const gitStatus = Bun.spawnSync(["git", "status", "--short"], {
			cwd: workspace,
		});
		const status = gitStatus.stdout.toString().trim();
		if (status) {
			parts.push(`<git_status>\n${status}\n</git_status>`);
		}
		const gitBranch = Bun.spawnSync(["git", "branch", "--show-current"], {
			cwd: workspace,
		});
		const branch = gitBranch.stdout.toString().trim();
		if (branch) {
			parts.push(`<git_branch>${branch}</git_branch>`);
		}
	} catch {}
	return parts.length > 0 ? parts.join("\n") : null;
}

/** 将用户回答注入到 history 中最后一个 SubmitToolResult */
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

export async function startCodeRepl(
	paths: CodeWorkspacePaths,
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

	let userInput = initialInput ?? (await prompt(`${label.user()} `));
	let history: DomainMessage[] = [
		{ type: "system", content: systemPrompt },
		{
			type: "system",
			content: buildWorkspaceContext(paths.workspace),
		},
		{
			type: "user_input",
			content: userInput,
			context: await gatherContext(paths.workspace),
			capabilities: null,
		},
	];

	while (userInput.trim().toLowerCase() !== "exit") {
		const agentResult = await agentLoop<CodeResult>(history, {
			maxIterations: 50,
			renderer,
			confirmFn,
			schema: CodeResultSchema,
		});
		history = agentResult.history;
		const ir = agentResult.result;
		writeln();

		if (ir == null) {
			writeln(`${style.red("✗")} Agent 异常终止`);
			if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
			writeln();
			userInput = await prompt(`${label.user()} `);
			history.push({
				type: "user_input",
				content: userInput,
				context: await gatherContext(paths.workspace),
				capabilities: null,
			});
			continue;
		}

		switch (ir.type) {
			case "need_info": {
				writeln(`${style.yellow("?")} ${ir.question}`);
				for (const [i, opt] of ir.options.entries()) {
					writeln(`  ${style.cyan(`${i + 1})`)} ${opt.choice}`);
					writeln(`     ${style.gray(opt.affect)}`);
				}
				writeln();
				userInput = await prompt(`${label.user()} `);
				injectUserResponse(history, userInput);
				continue;
			}
			case "completed": {
				writeln(`${style.green("✓")} 完成: ${ir.summary}`);
				if (ir.files_changed.length > 0) {
					writeln(style.gray(`  变更文件: ${ir.files_changed.join(", ")}`));
				}
				if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
				writeln();
				userInput = await prompt(`${label.user()} `);
				history.push({
					type: "user_input",
					content: userInput,
					context: await gatherContext(paths.workspace),
					capabilities: null,
				});
				break;
			}
		}
	}

	rl.close();
	writeln(style.gray("Bye!"));
}
