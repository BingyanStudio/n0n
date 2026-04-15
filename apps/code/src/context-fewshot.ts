/**
 * context-fewshot — 动态 bootstrap 教学场景
 *
 * 在会话启动时通过 Toolkit 的 exec 工具真实执行环境扫描命令，
 * 将结果嵌入 fewshot 历史。模型看到"自己"刚刚完成了环境初始化，
 * 从中自然获知：
 * - 当前平台、可用工具（从 shell 命令推断）
 * - AGENTS.md 项目指令
 * - 代码结构和规模
 * - git 状态
 *
 * 同时通过 .temp/bootstrap-test.md 临时任务教学：
 * - 先读后改（Turn 1 读 → Turn 2 改）
 * - write vs edit（新文件 write，已有文件 edit）
 * - 并行调用（Turn 1 四个独立 exec，Turn 2 四个不同工具）
 * - 验证后 submit（exec 运行验证 + 清理）
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import type {
	DomainMessage,
	ExecToolCall,
	SubmitToolCall,
	SubmitToolResult,
	ToolCallRecord,
	ToolResult,
	ToolStreamEvent,
} from "@n0n/types";
import type { Toolkit } from "@n0n/tools";

// ── bootstrap-test.md 内容（预置到 .temp/ 供扫描时发现） ──

const BOOTSTRAP_TASK = `# Bootstrap Task
1. Create .temp/hello.ts with: console.log("bootstrap ok")
2. Run it to verify bun works
3. Edit this file: change Status from PENDING to DONE
4. Clean up all temp files

Status: PENDING`;

// ── Turn 1 boot_3 的 bun 扫描脚本 ──

const SCAN_SCRIPT = `import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
let files = 0, lines = 0;
const IGNORE = new Set(["node_modules",".git",".temp","dist",".turbo","bun.lock"]);
async function walk(dir, depth = 0) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (IGNORE.has(e.name)) continue;
    if (e.name.startsWith(".") && depth === 0) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await walk(full, depth + 1);
      if (sub.length) out.push("  ".repeat(depth)+"📁 "+e.name+"/", ...sub);
    } else if (e.name.match(/\\.(ts|js)$/) && !e.name.endsWith(".d.ts")) {
      const c = (await readFile(full,"utf8")).split("\\n").length;
      files++; lines += c;
      out.push("  ".repeat(depth)+e.name+\` (\${c} lines)\`);
    }
  }
  return out;
}
const tree = await walk(".");
const display = tree.length > 60 ? [...tree.slice(0, 60), \`... (\${tree.length - 60} more)\`] : tree;
console.log(display.join("\\n"));
console.log(\`\\nTotal: \${files} source files, \${lines} lines\`);`;

// ── 通过 Toolkit exec 执行脚本并提取 ToolResult ──

async function runExec(
	toolkit: Toolkit,
	call: ExecToolCall,
): Promise<ToolResult> {
	const entry = toolkit.getEntry("exec");
	if (!entry || !entry.stream) {
		throw new Error("exec tool entry not found or not stream");
	}
	const gen = (entry.execute as (
		tc: ToolCallRecord,
		reminders: never[],
	) => AsyncGenerator<ToolStreamEvent>)(call, []);

	let result: ToolResult | undefined;
	for await (const event of gen) {
		if (event.type === "tool_result") {
			result = event;
		}
	}
	if (!result) {
		throw new Error(`exec tool did not yield a result for call ${call.id}`);
	}
	return result;
}

// ── 消息构造辅助 ──

function submitPair(
	id: string,
	args: Record<string, unknown>,
): [DomainMessage, DomainMessage] {
	const call: SubmitToolCall = { id, tool: "submit", args };
	return [
		{
			type: "assistant_tool_call",
			content: null,
			reasoning: null,
			reasoningSignature: null,
			toolCalls: [call],
		},
		{
			type: "tool_result",
			tool: "submit" as const,
			call,
			cleanedResult: args,
			userResponse: undefined,
		} satisfies SubmitToolResult as DomainMessage,
	];
}

// ── 主函数 ──

/**
 * 构建动态 bootstrap fewshot。
 *
 * 通过 Toolkit 的 exec 真实执行环境扫描命令，结果直接以 ExecToolResult
 * 格式嵌入 fewshot 历史——与 agent loop 中正常执行产出的消息格式完全一致。
 *
 * 返回的 DomainMessage[] 插入到 cache_breakpoint 之后、真实 user_input 之前。
 */
export async function buildContextFewshot(
	toolkit: Toolkit,
	workspace: string,
	tempDir: string,
): Promise<DomainMessage[]> {
	// 预置 bootstrap 任务文件
	const absTempDir = resolve(workspace, tempDir);
	if (!existsSync(absTempDir)) mkdirSync(absTempDir, { recursive: true });
	const taskFilePath = resolve(absTempDir, "bootstrap-test.md");
	writeFileSync(taskFilePath, BOOTSTRAP_TASK, "utf-8");

	// ── Turn 1: 4 个并行 exec 扫描 ──

	const turn1Calls: ExecToolCall[] = [
		{
			id: "boot_1",
			tool: "exec" as const,
			args: {
				script: 'echo "OS: $(uname -s)"; echo "Shell: $SHELL"; echo "Git branch: $(git branch --show-current 2>/dev/null || echo none)"; git status --short 2>/dev/null | head -20',
			},
		},
		{
			id: "boot_2",
			tool: "exec" as const,
			args: {
				script: "cat AGENTS.md 2>/dev/null || echo '(no AGENTS.md found)'",
			},
		},
		{
			id: "boot_3",
			tool: "exec" as const,
			args: {
				runtime: "bun",
				script: SCAN_SCRIPT,
			},
		},
		{
			id: "boot_4",
			tool: "exec" as const,
			args: {
				script: "cat .temp/bootstrap-test.md",
			},
		},
	];

	// 真实执行所有 Turn 1 命令，拿到 ExecToolResult
	const turn1Results = await Promise.all(
		turn1Calls.map((call) => runExec(toolkit, call)),
	);

	// 清理预置的 bootstrap 任务文件
	try {
		unlinkSync(taskFilePath);
	} catch {}

	// ── 从 boot_1 结果中提取环境摘要（用于 Turn 2 的 submit summary） ──

	const envResult = turn1Results[0]!;
	const envStdout =
		envResult.tool === "exec" && "stdout" in envResult
			? envResult.stdout
			: "stdoutSoFar" in envResult
				? (envResult as { stdoutSoFar: string }).stdoutSoFar
				: "";

	const codebaseResult = turn1Results[2]!;
	const codebaseStdout =
		codebaseResult.tool === "exec" && "stdout" in codebaseResult
			? codebaseResult.stdout
			: "";

	// 从 codebase 输出中提取 Total 行
	const totalLine =
		codebaseStdout.match(/Total: .+/)?.[0] ?? "项目结构已扫描";

	// 从环境输出中提取关键信息
	const osMatch = envStdout.match(/OS: (\S+)/);
	const branchMatch = envStdout.match(/Git branch: (\S+)/);
	const os = osMatch?.[1] ?? "unknown";
	const branch = branchMatch?.[1] ?? "unknown";

	const submitSummary = [
		`环境初始化完成。`,
		`${os}，工作目录 ${workspace}，当前在 ${branch} 分支。`,
		totalLine + "。",
		"就绪，等待指令。",
	].join("");

	// ── 构建消息序列 ──

	const messages: DomainMessage[] = [];

	// Message: user prompt（system-reminder 引导 + 请求）
	messages.push({
		type: "generic_user_text",
		content: [
			"<system-reminder>",
			"Bootstrap: discover your environment before the user's first message.",
			"1. Check OS, shell, and git state",
			"2. Read AGENTS.md for project-specific instructions",
			"3. Survey the codebase structure",
			"4. Read and complete the bootstrap task in .temp/bootstrap-test.md",
			"Submit when all steps are done.",
			"</system-reminder>",
			"",
			"帮我初始化工作环境。",
		].join("\n"),
	});

	// Message: assistant Turn 1（4 个并行 exec）
	messages.push({
		type: "assistant_tool_call",
		content: null,
		reasoning: null,
		reasoningSignature: null,
		toolCalls: turn1Calls,
	});

	// Message: 4 个 tool_result（真实的 ExecToolResult）
	for (const result of turn1Results) {
		messages.push(result);
	}

	// Message: assistant Turn 2（write + edit + exec + submit 并行）
	const turn2WriteCall: ToolCallRecord = {
		id: "boot_5",
		tool: "write" as const,
		args: {
			path: ".temp/hello.ts",
			content: 'console.log("bootstrap ok");\n',
		},
	};
	const turn2EditCall: ToolCallRecord = {
		id: "boot_6",
		tool: "edit" as const,
		args: {
			path: ".temp/bootstrap-test.md",
			intent: "Change Status from PENDING to DONE",
		},
	};
	const turn2ExecCall: ExecToolCall = {
		id: "boot_7",
		tool: "exec" as const,
		args: {
			script: "bun .temp/hello.ts && rm .temp/hello.ts .temp/bootstrap-test.md",
		},
	};
	const turn2SubmitCall: SubmitToolCall = {
		id: "boot_s",
		tool: "submit" as const,
		args: {
			type: "completed",
			summary: submitSummary,
		},
	};

	messages.push({
		type: "assistant_tool_call",
		content: null,
		reasoning: null,
		reasoningSignature: null,
		toolCalls: [turn2WriteCall, turn2EditCall, turn2ExecCall, turn2SubmitCall],
	});

	// Turn 2 tool results — write 和 edit 是静态构造的，exec 和 submit 也静态构造
	// （Turn 2 的操作对象是 Turn 1 预置的临时文件，此时已被清理，不适合真实执行）

	// write result
	messages.push({
		type: "tool_result",
		tool: "write" as const,
		call: turn2WriteCall as import("@n0n/types").WriteToolCall,
		status: "completed" as const,
	} satisfies DomainMessage);

	// edit result
	messages.push({
		type: "tool_result",
		tool: "edit" as const,
		call: turn2EditCall as import("@n0n/types").EditToolCall,
		diff: {
			chunks: [
				{
					startLine: 7,
					endLine: 7,
					lines: [{ line: 7, content: "Status: DONE", changed: true }],
				},
			],
			added: 1,
			removed: 1,
		},
		success: true,
		error: null,
		feedback: null,
		rounds: 1,
		durationMs: 800,
	} satisfies DomainMessage);

	// exec result（静态：bun hello.ts 输出 "bootstrap ok"）
	messages.push({
		type: "tool_result",
		tool: "exec" as const,
		call: turn2ExecCall,
		status: "completed" as const,
		exitCode: 0,
		stdout: "bootstrap ok",
		stderr: "",
		durationMs: 150,
	} satisfies DomainMessage);

	// submit result
	messages.push({
		type: "tool_result",
		tool: "submit" as const,
		call: turn2SubmitCall,
		cleanedResult: turn2SubmitCall.args,
		userResponse: undefined,
	} satisfies SubmitToolResult as DomainMessage);

	return messages;
}
