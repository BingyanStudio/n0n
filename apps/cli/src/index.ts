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
import { resolve } from "node:path";
import { style, writeln } from "@n0n/cli-ui";
import {
	discoverWorkflows,
	initConfig,
	loadSchedules,
	runWorkflow,
	type WorkspacePaths,
} from "@n0n/core";
import { startRepl } from "./repl.ts";

type CliWorkflowPaths = Pick<WorkspacePaths, "tasks" | "skills">;
type CliSchedulePaths = Pick<WorkspacePaths, "schedules">;
type CliTempPaths = Pick<WorkspacePaths, "temp">;

// ── 子命令路由 ──

function resolveCliWorkspacePaths(args: string[]): {
	workspacePaths: WorkspacePaths;
	args: string[];
} {
	const nextArgs = [...args];
	const workspaceFlagIndex = nextArgs.indexOf("--workspace");
	const workspaceValue =
		workspaceFlagIndex >= 0 ? nextArgs[workspaceFlagIndex + 1] : undefined;
	if (workspaceFlagIndex >= 0) {
		if (!workspaceValue) {
			throw new Error("--workspace requires a directory argument");
		}
		nextArgs.splice(workspaceFlagIndex, 2);
	}

	const workspace = resolve(
		workspaceValue ?? process.env.N0N_WORKSPACE ?? process.cwd(),
	);
	const workspacePaths = initConfig({
		workspace,
		workflows: ".runtime/cli/workflows",
		tasks: ".runtime/cli/workflows/tasks",
		skills: ".runtime/cli/workflows/skills",
		schedules: ".runtime/cli/workflows/schedules",
		memory: ".runtime/cli/workflows/memory",
		consultResult: ".runtime/cli/workflows/consult-result",
		history: ".runtime/cli/workflows/history",
		temp: ".runtime/cli/temp",
	});

	return { workspacePaths, args: nextArgs };
}

// ── 进程生命周期 ──

function cleanupTemp(paths: CliTempPaths): void {
	try {
		rmSync(paths.temp, { recursive: true, force: true });
	} catch {}
}

// 解析一次，main() 和 cleanup handler 共用
const _resolved = resolveCliWorkspacePaths(process.argv.slice(2));

async function main(): Promise<void> {
	const args = _resolved.args;
	const workspacePaths = _resolved.workspacePaths;
	const initialInput = args.length > 0 ? args.join(" ") : undefined;
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
			const workflows = await discoverWorkflows(
				false,
				workspacePaths satisfies CliWorkflowPaths,
			);
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
				const schedules = await loadSchedules(
					workspacePaths satisfies CliSchedulePaths,
				);
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
			await startRepl(workspacePaths, initialInput);
		}
	}
}

process.on("exit", () => cleanupTemp(_resolved.workspacePaths));
process.on("SIGINT", () => {
	cleanupTemp(_resolved.workspacePaths);
	process.exit(0);
});

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
