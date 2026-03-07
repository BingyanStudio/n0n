/**
 * CLI 入口 — 子命令路由 + 进程生命周期管理
 *
 * CLI:
 *   bun run apps/cli/src/index.ts                    交互式对话
 *   bun run apps/cli/src/index.ts run <workflow.ts>  运行已有 workflow
 *   bun run apps/cli/src/index.ts schedule ...       调度管理
 *   bun run apps/cli/src/index.ts workflows          列出 workflow
 *
 * 其他服务独立启动：
 *   bun run apps/feishu/src/index.ts                 飞书 Bot 服务
 */

import { rmSync } from "node:fs";
import { style, writeln } from "@n0n/cli-ui";
import {
	discoverWorkflows,
	loadSchedules,
	resolvePaths,
	runWorkflow,
} from "@n0n/core";
import { startRepl } from "./repl.ts";

/** CLI 默认 workspace */
const paths = resolvePaths(".runtime/workflows");

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
			const workflows = await discoverWorkflows(paths);
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
				const schedules = await loadSchedules(paths);
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

		default: {
			const initialInput = args.length > 0 ? args.join(" ") : undefined;
			await startRepl(initialInput, paths);
		}
	}
}

// ── 进程生命周期 ──

function cleanupTemp(): void {
	try {
		rmSync(paths.temp, { recursive: true, force: true });
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
