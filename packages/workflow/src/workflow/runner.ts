/**
 * Workflow Runner — 子进程执行入口
 *
 * 在独立 bun 子进程中执行 workflow，实现真正的 CWD 隔离。
 * 由 runWorkflow() 通过 Bun.spawn 调用，结果写入临时文件。
 *
 * Usage: bun run runner.ts <workflowPath> [argsJson]
 * Env:   __N0N_RESULT_FILE__ — 结果 JSON 写入路径
 */

import type { WorkflowModule } from "./runtime.ts";

const workflowPath = process.argv[2];
const argsJson = process.argv[3];
const resultFile = process.env.__N0N_RESULT_FILE__;

if (!workflowPath || !resultFile) {
	console.error(
		"Usage: bun run runner.ts <workflowPath> [argsJson]\nEnv __N0N_RESULT_FILE__ required.",
	);
	process.exit(1);
}

try {
	const mod = (await import(workflowPath)) as WorkflowModule;
	const entryFn = mod.default ?? mod.run;

	if (typeof entryFn !== "function") {
		const exports = Object.keys(mod).filter((k) => k !== "__esModule");
		throw new Error(
			`Workflow must export default/run function. Found: [${exports.join(", ")}]`,
		);
	}

	const args = argsJson ? JSON.parse(argsJson) : undefined;
	const result = await entryFn(args);

	await Bun.write(resultFile, JSON.stringify({ ok: true, value: result ?? null }));
} catch (err) {
	await Bun.write(
		resultFile,
		JSON.stringify({ ok: false, error: String(err) }),
	);
	process.exit(1);
}
