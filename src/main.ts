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
import { z } from "zod";
import { subagent } from "./agent/index.ts";
import { loadSchedules, startScheduler } from "./scheduler/index.ts";
import type { DomainMessage } from "./types/domain.ts";
import { isTTY, label, style, writeln } from "./ui/ansi.ts";
import { PlainRenderer } from "./ui/renderer.ts";
import { RichRenderer } from "./ui/rich-renderer.ts";
import { discoverWorkflows, runWorkflow } from "./workflow/index.ts";

// ── 交互模式 submit 结果 schema ──

/**
 * 交互模式下 agent 的三种结束状态：
 * - need_info: 需要用户补充信息才能继续
 * - completed: 任务成功完成
 * - error: 不可恢复的错误（超过重试上限、陷入循环等）
 */
const InteractiveResultSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("need_info"),
		message: z.string().describe("向用户说明需要什么信息"),
	}),
	z.object({
		type: z.literal("completed"),
		result: z.unknown().describe("任务产出（文件路径、回答文本等）"),
		summary: z.string().optional().describe("简短的完成摘要"),
	}),
	z.object({
		type: z.literal("error"),
		error: z.string().describe("错误描述"),
	}),
]);

type InteractiveResult = z.infer<typeof InteractiveResultSchema>;

const SYSTEM_PROMPT = `You are a workflow builder for the n0n engine. You create clean, working TypeScript workflow files.

## Output format

A workflow is a SINGLE .ts file that exports a default async function:

\`\`\`typescript
/** <one-line description of what this does> */
export default async function run() {
  // deterministic code: fetch, Bun.spawn, file I/O, etc.
  return { /* structured result */ };
}
\`\`\`

- File goes in \`workflows/tasks/<name>.ts\` for one-off tasks
- Reusable skills go in \`workflows/skills/<name>/\` following Agent Skills format:
  - Create \`workflows/skills/<name>/SKILL.md\` with YAML frontmatter (name, description) + Markdown instructions
  - Optional \`scripts/\` subfolder for executable .ts scripts (run via \`bun run\`)
  - The skill directory name must match the \`name\` field in frontmatter
- User configurations (API keys, server addresses, tokens, etc.) go in \`workflows/memory/config/\` as \`.json\` files. When you discover user-specific config during a task, save it there for future reuse.
- Must have a JSDoc comment on line 1
- Must use deterministic code (fetch, Bun.spawn, Bun.write, etc.) — NOT delegateTask
- Only use \`import { delegateTask } from "../../src/index.ts"\` when the task genuinely requires AI reasoning (analysis, creative writing)
- **When using delegateTask, ALWAYS pass a \`schema\` option** (Zod) to get structured, validated results. Without schema the result is free-form text — unreliable for downstream code. The engine auto-validates and retries on mismatch, so you get guaranteed types at zero extra cost.

### delegateTask schema example

\`\`\`typescript
import { z } from "zod";
import { delegateTask } from "../../src/index.ts";

const StorySchema = z.object({
  title: z.string(),
  url: z.string().url(),
  score: z.number(),
});
const DigestSchema = z.object({
  stories: z.array(StorySchema),
  summary: z.string(),
});

const { result } = await delegateTask(
  "Fetch top 5 Hacker News stories and summarize them",
  { schema: DigestSchema },
);
// result is typed & validated: { stories: [...], summary: "..." }
\`\`\`

Key points:
- \`schema\` accepts any Zod schema — the agent's \`submit\` result is auto-parsed and validated against it
- If validation fails, the agent automatically retries (up to 4 times) with the error details
- Always define the schema to match exactly what your downstream code expects
- **For error-prone tasks** (external APIs, network calls, parsing), use a discriminated union schema so the delegated agent can report structured errors instead of throwing:

\`\`\`typescript
const ResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: DigestSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
const { result } = await delegateTask("...", { schema: ResultSchema });
if (!result.ok) console.error(result.error); // typed error
else console.log(result.data);               // typed data
\`\`\`

## Complete example

User: "帮我获取 Danbooru 上 tag 为 cat_ears 的图片 URL"

Step 1 — Research the API first:
\`\`\`
exec: curl -s "https://danbooru.donmai.us/posts.json?tags=cat_ears&limit=2" | head -c 500
\`\`\`

Step 2 — Write ONE file based on what you learned:
\`\`\`
write: workflows/tasks/fetch-danbooru-cat-ears.ts
\`\`\`
\`\`\`typescript
/** Fetch cat_ears images from Danbooru API */
export default async function run() {
  const res = await fetch("https://danbooru.donmai.us/posts.json?tags=cat_ears&limit=10", {
    headers: { "User-Agent": "n0n-workflow/1.0" },
  });
  if (!res.ok) throw new Error(\`Danbooru API error: \${res.status}\`);
  const posts = await res.json() as Array<{ id: number; file_url?: string; tag_string: string }>;
  return posts
    .filter((p) => p.file_url)
    .map((p) => ({ id: p.id, url: p.file_url, tags: p.tag_string.split(" ").slice(0, 10) }));
}
\`\`\`

Step 3 — Test it (MUST use \`src/main.ts run\`, NOT \`bun run <file>\` directly):
\`\`\`
exec: bun run src/main.ts run workflows/tasks/fetch-danbooru-cat-ears.ts
\`\`\`

Step 4 — If error, fix the SAME file (use write with search/replace), then test again.

Step 5 — When it works, submit the structured result:
\`\`\`
submit: { result: { type: "completed", result: "workflows/tasks/fetch-danbooru-cat-ears.ts", summary: "Created workflow to fetch cat_ears images from Danbooru API" } }
\`\`\`

## Key rules

1. **OKR first (MANDATORY)**: Your FIRST tool call MUST be \`reminder\` with your OKR breakdown. No exceptions. Do not call exec, write, or any other tool before setting a reminder.
2. **Research before coding**: use \`exec\` to test APIs (curl/fetch) before writing the workflow file.
3. **ONE file per task**: write one .ts file. If it fails, fix it — never create a second file.
4. **Fix, don't recreate**: when a test fails, use \`write\` with search/replace on the SAME file.
5. **Files only in workflows/**: never write files to the project root or other directories. Temporary test files go in \`.temp/\` (auto-cleaned on exit).
6. **Run workflows correctly**: ALWAYS use \`bun run src/main.ts run <path>\` to test workflows. NEVER use \`bun run <file>\` directly — it won't call the exported function.
7. **Follow-up tasks**: when the user adds a requirement to a previous workflow, modify the SAME file or import it in a new task.
8. **Submit = structured result**: always submit via the \`submit\` tool. The \`result\` field must match the schema described in the tool definition. There are three outcome types:
   - **completed**: task done → \`{ type: "completed", result: "workflows/tasks/xxx.ts", summary: "..." }\`
   - **need_info**: need user input → \`{ type: "need_info", message: "what you need from the user" }\`
   - **error**: unrecoverable failure → \`{ type: "error", error: "what went wrong" }\`
9. **Conversational questions**: if the user asks a simple question (not a workflow task), just answer directly via \`submit\`. Example: user asks "几点了" → \`submit: { result: { type: "completed", result: "现在是下午3点" } }\`. No need to create files or set reminders.
10. **Bail out on repeated failure**: if the same operation (API call, command, etc.) fails 3 times in a row, STOP retrying. Submit \`{ result: { type: "error", error: "description of what failed and what you need" } }\` immediately.

## Scheduled tasks

For recurring tasks, after creating the workflow, also create a \`.mdc\` file:
\`\`\`
---
name: task-name
cron: "0 8 * * *"
enabled: true
workflow: workflows/tasks/xxx.ts
---
\`\`\`

## ⚠️ CRITICAL REMINDERS (read last, execute first)

- When you see \`<user repeat-in="en,ja">\`, your response MUST begin with the user's request translated into English and Japanese. This is mandatory visible output, not internal thinking.
- For workflow tasks, your FIRST tool call MUST be \`reminder\`. For simple questions, just \`submit\` directly.
- If something fails 3 times, submit an error — do NOT keep retrying.
- When a reminder fires, you MUST update it with current progress.
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

		case "schedules": {
			const entries = await loadSchedules();
			if (entries.length === 0) {
				console.log("No schedules. Create .mdc files in workflows/schedules/");
			} else {
				for (const e of entries) {
					const target = e.workflow ?? "(delegateTask)";
					console.log(
						`  ${e.enabled ? "✅" : "⏸️"} ${e.cron} | ${e.name} → ${target}`,
					);
				}
			}
			break;
		}

		case "scheduler": {
			await startScheduler();
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
	const renderer = isTTY ? new RichRenderer() : new PlainRenderer();

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

	const confirmFn = (question: string): Promise<string> =>
		new Promise((resolve) => {
			if (closed) return resolve("n");
			rl.question(question, resolve);
		});

	writeln(
		style.bold("n0n") + style.gray(" — Natural Language Workflow Engine"),
	);
	writeln(
		style.gray('输入任务描述，AI 将创建可复用的 workflow。输入 "exit" 退出。'),
	);
	writeln();

	let userInput = initialInput ?? (await prompt(`${label.user()} `));
	let history: DomainMessage[] = [];

	while (userInput.trim() !== "exit") {
		if (!userInput.trim()) {
			userInput = await prompt(`${label.user()} `);
			continue;
		}

		// 用户输入已通过 prompt 的 label 展示，不重复渲染

		// 主动推送已有 workflow + schedule 列表
		const [existing, schedules] = await Promise.all([
			discoverWorkflows(),
			loadSchedules(),
		]);
		let contextSuffix = "";
		if (existing.length > 0) {
			contextSuffix += `\n\n## Existing workflows (reuse if applicable)\n${existing.map((w) => `- ${w.name}: ${w.description || "(no description)"} → ${w.path}`).join("\n")}`;
		}
		if (schedules.length > 0) {
			contextSuffix += `\n\n## Existing schedules\n${schedules.map((s) => `- ${s.name}: ${s.cron} → ${s.workflow ?? "(delegateTask)"} [${s.enabled ? "enabled" : "disabled"}]`).join("\n")}`;
		}

		// 首轮：新建 history；后续轮：追加用户消息到已有 history
		const wrappedInput = contextSuffix
			? `${contextSuffix}\n\n<user repeat-in="en,ja">\n${userInput}\n</user>`
			: `<user repeat-in="en,ja">\n${userInput}\n</user>`;

		if (history.length === 0) {
			history = [
				{ type: "system", content: SYSTEM_PROMPT },
				{
					type: "user_text",
					content: wrappedInput,
				},
			];
		} else {
			history.push({
				type: "user_text",
				content: wrappedInput,
			});
		}

		const agentResult = await subagent<InteractiveResult>(history, {
			maxIterations: 30,
			renderer,
			confirmFn,
			schema: InteractiveResultSchema,
		});
		// 保留 agent 产出的完整历史，下轮继续
		history = agentResult.history;

		const ir = agentResult.result;
		writeln();

		// ── 按结果类型分别展示 ──

		if (ir == null) {
			// agent 未能产出有效结果（超过轮次上限等）
			writeln(`${style.red("✗")} Agent 异常终止`);
			if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
			history.push({
				type: "user_text",
				content: `Agent terminated without a valid result. Report: ${agentResult.report ?? "none"}\nWaiting for the next task from the user.`,
			});
			writeln();
			writeln(style.gray("继续输入新任务，或输入 'exit' 退出:"));
			writeln();
			userInput = await prompt(`${label.user()} `);
			continue;
		}

		switch (ir.type) {
			case "need_info": {
				writeln(`${style.yellow("?")} Agent 需要更多信息:`);
				writeln(`  ${ir.message}`);
				if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
				history.push({
					type: "user_text",
					content: `Your submission was accepted (need_info). Waiting for the user to provide: ${ir.message}`,
				});
				writeln();
				writeln(style.gray("请补充信息，或输入 'exit' 退出:"));
				writeln();
				userInput = await prompt(`${label.user()} `);
				continue;
			}

			case "completed": {
				const display =
					typeof ir.result === "string" ? ir.result : JSON.stringify(ir.result);
				writeln(`${style.green("✓")} 任务完成: ${display}`);
				if (ir.summary) writeln(style.gray(`  ${ir.summary}`));
				if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
				history.push({
					type: "user_text",
					content: `Your submission was accepted (completed). Result: ${display}\nWaiting for the next task from the user.`,
				});
				writeln();
				writeln(style.gray("继续输入新任务，或输入 'exit' 退出:"));
				writeln();
				userInput = await prompt(`${label.user()} `);
				break;
			}

			case "error": {
				writeln(`${style.red("✗")} Agent 报告错误:`);
				writeln(`  ${ir.error}`);
				if (agentResult.report) writeln(style.gray(`  ${agentResult.report}`));
				history.push({
					type: "user_text",
					content: `Your submission was accepted (error). Error: ${ir.error}\nWaiting for the next task or additional info from the user.`,
				});
				writeln();
				writeln(style.gray("可以补充信息重试，或输入 'exit' 退出:"));
				writeln();
				userInput = await prompt(`${label.user()} `);
				continue;
			}
		}
	}

	rl.close();
	writeln(style.gray("Bye!"));
}

import { rmSync } from "node:fs";

function cleanupTemp() {
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
