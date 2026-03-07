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
	defaultPaths,
	PlainRenderer,
	type WorkspacePaths,
} from "@n0n/core";
import type { DomainMessage, SubmitToolResult } from "@n0n/types";
import { type CodeResult, CodeResultSchema } from "./schema.ts";

const PROMPT_PATH = resolve(import.meta.dir, "prompts", "code.md");

/**
 * 读取目标项目的 AGENTS.md（项目级编码规范）。
 * 支持 AGENTS.md 和 .agents.md 两种命名。
 */
async function loadAgentsMd(): Promise<string | null> {
	for (const name of ["AGENTS.md", ".agents.md"]) {
		const file = Bun.file(resolve(process.cwd(), name));
		if (await file.exists()) {
			const content = await file.text();
			if (content.trim()) return content.trim();
		}
	}
	return null;
}

/** 获取项目上下文（git status + 目录结构） */
async function gatherContext(): Promise<string | null> {
	const parts: string[] = [];
	try {
		const gitStatus = Bun.spawnSync(["git", "status", "--short"]);
		const status = gitStatus.stdout.toString().trim();
		if (status) {
			parts.push(`<git_status>\n${status}\n</git_status>`);
		}
		const gitBranch = Bun.spawnSync(["git", "branch", "--show-current"]);
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
	initialInput?: string,
	paths: WorkspacePaths = defaultPaths,
): Promise<void> {
	const systemPrompt = await Bun.file(PROMPT_PATH).text();
	const agentsMd = await loadAgentsMd();
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
	const systemMessages: DomainMessage[] = [
		{ type: "system", content: systemPrompt },
	];
	if (agentsMd) {
		systemMessages.push({
			type: "system",
			content: `<project_rules>\n${agentsMd}\n</project_rules>`,
		});
	}
	let history: DomainMessage[] = [
		...systemMessages,
		{
			type: "user_input",
			content: userInput,
			context: await gatherContext(),
			capabilities: null,
		},
	];

	while (userInput.trim().toLowerCase() !== "exit") {
		const agentResult = await agentLoop<CodeResult>(history, {
			maxIterations: 50,
			renderer,
			confirmFn,
			schema: CodeResultSchema,
			paths,
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
				context: await gatherContext(),
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
					context: await gatherContext(),
					capabilities: null,
				});
				break;
			}
		}
	}

	rl.close();
	writeln(style.gray("Bye!"));
}
