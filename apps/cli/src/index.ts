/**
 * CLI 入口 — 子命令路由 + 进程生命周期管理
 *
 * CLI:
 *   bun run apps/cli/src/index.ts                    交互式对话
 *   bun run apps/cli/src/index.ts run <workflow.ts>  运行已有 workflow
 *   bun run apps/cli/src/index.ts schedule ...       调度管理
 *   bun run apps/cli/src/index.ts scheduler start    启动调度器
 *   bun run apps/cli/src/index.ts feishu start       启动飞书服务
 *   bun run apps/cli/src/index.ts workflows          列出 workflow
 */

import { rmSync } from "node:fs";
import {
	discoverWorkflows,
	loadSchedules,
	runWorkflow,
	startScheduler,
} from "@n0n/core";
import { startRepl } from "./repl.ts";
import { style, writeln } from "./ui/ansi.ts";

// ── 子命令路由 ──

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];

	switch (command) {
		case "run": {
			const workflowPath = args[1];
			if (!workflowPath) {
				console.error("Usage: bun run apps/cli/src/index.ts run <workflow.ts>");
				process.exit(1);
			}
			const result = await runWorkflow(workflowPath);
			console.log(JSON.stringify(result, null, 2));
			return;
		}

		case "workflows": {
			const workflows = await discoverWorkflows();
			if (workflows.length === 0) {
				writeln(style.gray("No workflows found."));
				return;
			}
			for (const w of workflows) {
				writeln(
					`  ${style.cyan(w.name)} ${style.gray("→")} ${w.path}${w.description ? `\n    ${style.gray(w.description)}` : ""}`,
				);
			}
			return;
		}

		case "schedule": {
			const sub = args[1];
			if (sub === "list" || !sub) {
				const schedules = await loadSchedules();
				if (schedules.length === 0) {
					writeln(style.gray("No schedules found."));
					return;
				}
				for (const s of schedules) {
					const status = s.enabled ? style.green("●") : style.gray("○");
					writeln(
						`  ${status} ${style.cyan(s.name)} ${style.gray(s.cron)} → ${s.workflow ?? style.gray("(delegateTask)")}`,
					);
				}
				return;
			}
			console.error(`Unknown schedule subcommand: ${sub}`);
			process.exit(1);
			return;
		}

		case "scheduler": {
			if (args[1] === "start") {
				await startScheduler();
				return;
			}
			console.error("Usage: bun run apps/cli/src/index.ts scheduler start");
			process.exit(1);
			return;
		}

		case "feishu": {
			// 动态导入 feishu app 以避免硬依赖
			try {
				const { startFeishuService } = await import(
					"../../feishu/src/index.ts"
				);
				await startScheduler();
				await startFeishuService();
			} catch (err) {
				console.error("Failed to start Feishu service:", err);
				process.exit(1);
			}
			return;
		}

		default: {
			const initialInput = args.length > 0 ? args.join(" ") : undefined;
			await startRepl(initialInput);
		}
	}
}

// ── 进程生命周期 ──

function cleanupTemp(): void {
	try {
		rmSync(".temp", { recursive: true, force: true });
	} catch {}
}

process.on("exit", cleanupTemp);
process.on("SIGINT", () => {
	cleanupTemp();
	process.exit(0);
});

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
