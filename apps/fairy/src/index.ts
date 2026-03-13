/**
 * Fairy CLI 入口 — 交互式对话循环
 *
 * MVP 实现：从状态重建上下文，执行 agentLoop，更新状态。
 * 每轮对话都是 state + stimulus → response + new-state。
 */

import { createInterface } from "node:readline";
import { isTTY, label, RichRenderer, style, writeln } from "@n0n/cli-ui";
import {
	agentLoop,
	createRuntimeContext,
	initRuntime,
	PlainRenderer,
} from "@n0n/core";
import { parseWorkspaceArg } from "@n0n/shared";
import type { DomainMessage } from "@n0n/types";
import { type FairyResponse, FairyResponseSchema } from "./schema.ts";
import {
	ensureFairyFiles,
	loadHistory,
	resolveFairyPaths,
	saveHistory,
} from "./state.ts";
import { buildView } from "./view.ts";

// ── 初始化 ──

const { workspace, remainingArgs } = parseWorkspaceArg(
	process.argv.slice(2),
	"N0N_FAIRY_WORKSPACE",
	`${process.cwd()}/.runtime/fairy`,
);

const paths = resolveFairyPaths(workspace);
ensureFairyFiles(paths);
const runtime = createRuntimeContext();
initRuntime(runtime);

// ── REPL ──

async function main(): Promise<void> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: isTTY,
	});

	const prompt = (query: string): Promise<string> =>
		new Promise((resolve) => rl.question(query, resolve));

	const renderer = isTTY ? new RichRenderer() : new PlainRenderer();

	let abortController = new AbortController();
	let agentRunning = false;

	// Ctrl+C 处理
	if (isTTY) {
		rl.on("SIGINT", () => {
			if (agentRunning) {
				abortController.abort();
			} else {
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
		`${style.bold("fairy")} ${style.gray(`— Persistent AI Companion [${paths.workspace}]`)}`,
	);
	writeln(style.gray('与你的 fairy 对话。输入 "exit" 退出，Ctrl+C 中断输出。'));
	writeln();

	const initialInput =
		remainingArgs.length > 0 ? remainingArgs.join(" ") : undefined;

	let userInput = initialInput ?? (await prompt(`${label.user()} `));

	while (userInput.trim().toLowerCase() !== "exit") {
		// 每轮从状态重建上下文
		const history = loadHistory(paths);
		const messages = buildView(history, paths, userInput);

		abortController = new AbortController();
		agentRunning = true;

		let agentResult: Awaited<ReturnType<typeof agentLoop<FairyResponse>>>;
		try {
			agentResult = await agentLoop<FairyResponse>(messages, {
				maxIterations: 30,
				renderer,
				schema: FairyResponseSchema,
				signal: abortController.signal,
				toolsWorkspace: {
					workspace: paths.workspace,
					tempDir: paths.temp,
				},
			});
		} catch (err) {
			writeln();
			writeln(`${style.red("✗")} Agent 运行出错，已中止本轮。`);
			const message =
				err instanceof Error ? err.message : String(err ?? "未知错误");
			writeln(style.gray(`  ${message}`));
			writeln();
			userInput = await prompt(`${label.user()} `);
			continue;
		} finally {
			agentRunning = false;
		}

		// 被用户中断
		if (abortController.signal.aborted) {
			writeln();
			userInput = await prompt(`${label.user()} `);
			continue;
		}

		// 更新全局对话记录：追加本轮产生的新消息
		updateHistory(paths, history, agentResult.history);

		writeln();

		if (agentResult.result == null) {
			writeln(`${style.red("✗")} Agent 异常终止`);
			if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
		} else {
			writeln(agentResult.result.reply);
		}

		writeln();
		userInput = await prompt(`${label.user()} `);
	}

	rl.close();
	writeln(style.gray("Bye!"));
}

/**
 * 更新全局对话记录。
 *
 * agentLoop 返回的 history 包含了 buildView 注入的 system 消息 + 本轮新消息。
 * 我们只需要追加本轮新产生的消息（跳过 buildView 注入的前缀）。
 */
function updateHistory(
	paths: FairyPaths,
	oldHistory: DomainMessage[],
	agentHistory: DomainMessage[],
): void {
	// buildView 注入的消息数量 = system messages + 1 user_input
	// 找到 agentHistory 中第一个非 system 的 user_input（即我们注入的 stimulus）
	let startIdx = 0;
	for (let i = 0; i < agentHistory.length; i++) {
		const msg = agentHistory[i];
		if (msg?.type === "user_input") {
			// 这是我们注入的 stimulus，从这里开始是本轮的内容
			startIdx = i;
			break;
		}
	}

	const newMessages = agentHistory.slice(startIdx);
	const updated = [...oldHistory, ...newMessages];
	saveHistory(paths, updated);
}

// ── 类型导入（避免 TS 报错） ──
import type { FairyPaths } from "./state.ts";

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
