/**
 * Scheduler 独立入口
 *
 * 启动定时调度器，监控 workflows/schedules/*.mdc
 */

import { startScheduler } from "@n0n/core";

startScheduler().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
