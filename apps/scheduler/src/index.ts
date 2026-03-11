/**
 * Scheduler 独立入口
 *
 * 启动定时调度器，监控 workflows/schedules/*.mdc
 */

import {
	createRuntimeContext,
	ensureDirs,
	initRuntime,
	resolveWorkflowPaths,
	startScheduler,
} from "@n0n/core";

const workspace = process.env.N0N_SCHEDULER_WORKSPACE ?? `${process.cwd()}/.runtime/scheduler`;
const paths = resolveWorkflowPaths(workspace);
ensureDirs(paths);
const runtime = createRuntimeContext();
initRuntime(runtime, paths);

startScheduler(paths).catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
