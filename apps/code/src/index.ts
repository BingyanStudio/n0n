/**
 * Code Agent — 入口
 *
 * 代码编写场景的 agent，产出物为项目代码变更（而非 workflow）。
 * 支持 --workspace 参数指定工作目录（默认 .runtime/code）。
 * workspace 同时作为 exec 工具的默认 cwd 和运行时数据目录。
 */

// ── 解析 --workspace（必须在其他模块加载前执行） ──

const rawArgs = process.argv.slice(2);
let workspaceDir = ".runtime/code";
const wsIdx = rawArgs.indexOf("--workspace");
if (wsIdx !== -1) {
	const targetWs = rawArgs[wsIdx + 1];
	if (!targetWs) {
		console.error("--workspace requires a directory argument");
		process.exit(1);
	}
	workspaceDir = targetWs;
	rawArgs.splice(wsIdx, 2);
}

// chdir 到 workspace，确保 exec 工具默认在此目录执行
process.chdir(workspaceDir);

// ── 加载模块（此时 process.cwd() 已是 workspace 目录） ──

const { style, writeln } = await import("@n0n/cli-ui");
const { resolvePaths } = await import("@n0n/core");
const { startCodeRepl } = await import("./repl.ts");

const paths = resolvePaths(workspaceDir);
const initialInput = rawArgs.length > 0 ? rawArgs.join(" ") : undefined;

writeln(
	style.bold("n0n code") + style.gray(` — Code Agent [${process.cwd()}]`),
);
writeln(
	style.gray('描述你的编码任务，AI 将直接修改项目代码。输入 "exit" 退出。'),
);
writeln();

await startCodeRepl(initialInput, paths);
