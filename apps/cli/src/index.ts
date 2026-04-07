/**
 * CLI 入口 — 子命令路由 + 进程生命周期管理
 *
 * @deprecated 此模块不再维护
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
import { createRuntimeContext, initRuntime } from "@n0n/core";
import { buildLLMConfigFromEnv, createLLMClient } from "@n0n/llm";
import { loadSchedules } from "@n0n/scheduler";
import { ensureDirs, parseWorkspaceArg } from "@n0n/shared";
import {
	discoverWorkflows,
	resolveWorkflowPaths,
	runWorkflow,
	type WorkflowPaths,
} from "@n0n/workflow";
import { startRepl } from "./repl.ts";

// ── 初始化 ──

const { workspace, remainingArgs } = parseWorkspaceArg(
	process.argv.slice(2),
	"N0N_CLI_WORKSPACE",
	`${process.cwd()}/.runtime/cli`,
);

const workspacePaths = resolveWorkflowPaths(workspace);
ensureDirs(workspacePaths);
const llmConfig = buildLLMConfigFromEnv("LLM");
const editorLlmConfig = buildLLMConfigFromEnv(
	"EDITOR_LLM",
	llmConfig.providerConfig,
);
const runtime = createRuntimeContext({
	client: createLLMClient(llmConfig),
	editBackend: { type: "str-replace", editorClient: createLLMClient(editorLlmConfig) },
});
initRuntime(runtime);

// ── 子命令路由 ──

type CliSchedulePaths = Pick<WorkflowPaths, "schedules">;

function cleanupTemp(paths: Pick<WorkflowPaths, "temp">): void {
	try {
		rmSync(paths.temp, { recursive: true, force: true });
	} catch {}
}

async function main(): Promise<void> {
	const args = remainingArgs;
	const initialInput = args.length > 0 ? args.join(" ") : undefined;
	const command = args[0];

	switch (command) {
		case "run": {
			const rawPath = args[1];
			if (!rawPath) {
				console.error("Usage: bun run apps/cli/src/index.ts run <workflow.ts>");
				process.exit(1);
			}
			const workflowPath = resolve(workspacePaths.workspace, rawPath);
			const result = await runWorkflow(workflowPath);
			console.log(JSON.stringify(result, null, 2));
			return;
		}

		case "workflows": {
			const workflows = await discoverWorkflows(false, workspacePaths);
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

process.on("exit", () => cleanupTemp(workspacePaths));

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
