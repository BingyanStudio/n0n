/**
 * Code Agent — 入口
 *
 * 代码编写场景的 agent，产出物为项目代码变更（而非 workflow）。
 * 支持 --cwd 参数指定工作目录（在模块加载前 chdir，确保工具使用正确的 cwd）。
 * 支持 --workspace 参数指定 workspace 目录（默认 .runtime/code）。
 */

// ── 解析 --cwd 和 --workspace（必须在其他模块加载前执行） ──

const rawArgs = process.argv.slice(2);
const cwdIdx = rawArgs.indexOf("--cwd");
if (cwdIdx !== -1) {
	const targetDir = rawArgs[cwdIdx + 1];
	if (!targetDir) {
		console.error("--cwd requires a directory argument");
		process.exit(1);
	}
	process.chdir(targetDir);
	rawArgs.splice(cwdIdx, 2);
}

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

// ── 加载模块（此时 process.cwd() 已是目标目录） ──

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
