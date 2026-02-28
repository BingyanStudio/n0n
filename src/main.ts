/**
 * n0n — 自然语言驱动的工作流引擎
 *
 * 核心交互流程：
 *   用户输入自然语言 → workflow-builder agent 编写 .ts workflow →
 *   运行验证 → submit error 时用户可补充信息 → 成功时保存 workflow
 *
 * CLI:
 *   bun run src/main.ts                    交互式对话
 *   bun run src/main.ts run <workflow.ts>  运行已有 workflow
 *   bun run src/main.ts schedule ...       调度管理
 *   bun run src/main.ts scheduler start    启动调度器
 *   bun run src/main.ts workflows          列出 workflow
 */

import { createInterface } from "node:readline";
import { subagent } from "./agent/index.ts";
import {
	addSchedule,
	listSchedules,
	removeSchedule,
	startScheduler,
} from "./scheduler/index.ts";
import { discoverWorkflows, runWorkflow } from "./workflow/index.ts";

const SYSTEM_PROMPT = `You are a workflow builder agent for the n0n engine.

Your job: when the user describes a task, you CREATE a reusable TypeScript workflow file that accomplishes it.

## How workflows work

Workflow files are .ts files in the workflows/ directory. They can be:

### 1. Direct code workflows (for deterministic tasks)
\`\`\`typescript
/** Fetch Tokyo weather from wttr.in */
export default async function run() {
  const proc = Bun.spawn(["curl", "-s", "https://wttr.in/Tokyo?format=j1"], { stdout: "pipe" });
  const text = await new Response(proc.stdout).text();
  const data = JSON.parse(text);
  return { city: "Tokyo", temp: data.current_condition[0].temp_C + "°C" };
}
\`\`\`

### 2. AI-powered workflows (for tasks requiring reasoning)
\`\`\`typescript
import { subagent } from "../../src/index.ts";
/** Analyze a CSV file for anomalies */
export default async function run() {
  const result = await subagent("Analyze data/sample.csv for anomalies, report findings");
  return result.result;
}
\`\`\`

Use direct code when the task is deterministic (API calls, data transforms, file operations).
Use subagent when the task requires AI reasoning (analysis, summarization, creative tasks).

## Your workflow

1. Understand what the user wants
2. Write a .ts workflow file using \`write\` tool to workflows/tasks/ or workflows/skills/
3. Test it with \`exec\`: bun run <workflow-path>
4. If it errors, read the error, fix the code, and test again
5. When it works, \`submit\` the workflow file path as your result
6. If you need information you don't have, submit { ok: false, error: "what you need" }

## Rules
- Skills (reusable components) go in workflows/skills/
- Tasks (complete workflows) go in workflows/tasks/
- Every file must have a JSDoc comment describing what it does
- Always test before submitting
- Prefer direct code over subagent when the task is deterministic
`;

const [command, ...args] = process.argv.slice(2);

async function main() {
	switch (command) {
		case "run": {
			const path = args[0];
			if (!path) {
				console.error("Usage: n0n run <workflow.ts>");
				process.exit(1);
			}
			console.log(`⚡ Running workflow: ${path}\n`);
			const result = await runWorkflow(path);
			console.log("\n✅ Workflow result:", result);
			break;
		}

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

		case "scheduler": {
			if (args[0] === "start") {
				await startScheduler();
			} else {
				console.error("Usage: n0n scheduler start");
				process.exit(1);
			}
			break;
		}

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

		// 默认：交互式对话
		default: {
			await interactiveLoop(command ? [command, ...args].join(" ") : undefined);
			break;
		}
	}
}

/**
 * 交互式对话循环
 *
 * 用户输入 → agent 编写 workflow → submit result/error →
 * error 时用户可补充信息继续 → 成功时结束
 */
async function interactiveLoop(initialInput?: string) {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	let closed = false;
	rl.once("close", () => {
		closed = true;
	});

	const prompt = (question: string): Promise<string> =>
		new Promise((resolve) => {
			if (closed) return resolve("exit");
			rl.question(question, resolve);
		});

	console.log("n0n — Natural Language Workflow Engine");
	console.log('输入任务描述，AI 将创建可复用的 workflow。输入 "exit" 退出。\n');

	let userInput = initialInput ?? (await prompt("🧑 > "));

	while (userInput.trim() !== "exit") {
		if (!userInput.trim()) {
			userInput = await prompt("🧑 > ");
			continue;
		}

		console.log("\n🤖 正在创建 workflow...\n");

		const result = await subagent(userInput, {
			systemPrompt: SYSTEM_PROMPT,
			maxIterations: 30,
		});

		// 检查是否为 error result
		const isError =
			result.result != null &&
			typeof result.result === "object" &&
			(result.result as Record<string, unknown>).ok === false;

		if (isError) {
			const errMsg = (result.result as Record<string, unknown>).error;
			console.log(`\n⚠️ Agent 需要更多信息: ${errMsg}`);
			if (result.report) console.log(`📋 ${result.report}`);
			console.log("请补充信息，或输入 'exit' 退出:\n");
			userInput = await prompt("🧑 > ");
			continue;
		}

		console.log("\n✅ Workflow 创建完成:", result.result);
		if (result.report) console.log(`📋 ${result.report}`);
		console.log("\n继续输入新任务，或输入 'exit' 退出:\n");
		userInput = await prompt("🧑 > ");
	}

	rl.close();
	console.log("Bye!");
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
