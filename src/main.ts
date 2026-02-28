/**
 * n0n — 自然语言驱动的工作流引擎
 *
 * CLI 入口：
 *   bun run src/main.ts chat "你的任务描述"
 *   bun run src/main.ts run <workflow-path>
 *   bun run src/main.ts schedule add <name> <cron> <task>
 *   bun run src/main.ts schedule list
 *   bun run src/main.ts schedule remove <id>
 *   bun run src/main.ts scheduler start
 *   bun run src/main.ts workflows
 */

import { subagent } from "./agent/index.ts";
import {
	addSchedule,
	listSchedules,
	removeSchedule,
	startScheduler,
} from "./scheduler/index.ts";
import { delegateTask } from "./task/index.ts";
import { discoverWorkflows, runWorkflow } from "./workflow/index.ts";

const [command, ...args] = process.argv.slice(2);

async function main() {
	switch (command) {
		// ── 直接对话（简单 subagent） ──
		case "chat": {
			const task = args.join(" ");
			if (!task) {
				console.error("Usage: n0n chat <task description>");
				process.exit(1);
			}
			console.log(`\n🤖 Starting agent for: ${task}\n`);
			const result = await subagent(task);
			console.log("\n✅ Result:", result.result);
			if (result.report) console.log("📋 Report:", result.report);
			break;
		}

		// ── delegateTask（完整流水线） ──
		case "task": {
			const task = args.join(" ");
			if (!task) {
				console.error("Usage: n0n task <task description>");
				process.exit(1);
			}
			console.log(`\n🚀 Delegating task: ${task}\n`);
			const result = await delegateTask(task);
			console.log("\n✅ Result:", result.result);
			if (result.report) console.log("📋 Report:", result.report);
			break;
		}

		// ── 运行 workflow 文件 ──
		case "run": {
			const path = args[0];
			if (!path) {
				console.error("Usage: n0n run <workflow-path.ts>");
				process.exit(1);
			}
			console.log(`\n⚡ Running workflow: ${path}\n`);
			const result = await runWorkflow(path);
			console.log("\n✅ Workflow result:", result);
			break;
		}

		// ── 调度管理 ──
		case "schedule": {
			const sub = args[0];
			switch (sub) {
				case "add": {
					const [, name, cron, ...taskParts] = args;
					const task = taskParts.join(" ");
					if (!name || !cron || !task) {
						console.error('Usage: n0n schedule add <name> "<cron>" <task>');
						process.exit(1);
					}
					const entry = await addSchedule(name, cron, task);
					console.log("✅ Schedule added:", entry);
					break;
				}
				case "list": {
					const entries = await listSchedules();
					if (entries.length === 0) {
						console.log("No schedules.");
					} else {
						for (const e of entries) {
							console.log(
								`  ${e.enabled ? "✅" : "⏸️"} ${e.id.slice(0, 8)} | ${e.cron} | ${e.name}: ${e.task}`,
							);
						}
					}
					break;
				}
				case "remove": {
					const id = args[1];
					if (!id) {
						console.error("Usage: n0n schedule remove <id>");
						process.exit(1);
					}
					const ok = await removeSchedule(id);
					console.log(ok ? "✅ Removed" : "❌ Not found");
					break;
				}
				default:
					console.error("Usage: n0n schedule <add|list|remove>");
					process.exit(1);
			}
			break;
		}

		// ── 启动调度器 ──
		case "scheduler": {
			if (args[0] === "start") {
				await startScheduler();
			} else {
				console.error("Usage: n0n scheduler start");
				process.exit(1);
			}
			break;
		}

		// ── 列出所有 workflow ──
		case "workflows": {
			const workflows = await discoverWorkflows();
			if (workflows.length === 0) {
				console.log(
					"No workflows found. Create .ts files in workflows/skills/ or workflows/tasks/",
				);
			} else {
				for (const w of workflows) {
					console.log(`  📄 ${w.name}: ${w.description || "(no description)"}`);
				}
			}
			break;
		}

		default:
			console.log(`
n0n — Natural Language Workflow Engine

Commands:
  chat <task>                       Quick agent conversation
  task <task>                       Full delegateTask pipeline (consult + RAG + execute)
  run <workflow.ts>                 Run a workflow file
  schedule add <name> <cron> <task> Add a scheduled task
  schedule list                     List scheduled tasks
  schedule remove <id>              Remove a scheduled task
  scheduler start                   Start the scheduler daemon
  workflows                         List discovered workflows
`);
	}
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
