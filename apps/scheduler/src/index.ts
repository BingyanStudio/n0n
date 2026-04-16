/**
 * Scheduler 独立入口
 *
 * 启动定时调度器，监控 workflows/schedules/*.mdc
 */

import { createRuntimeContext, initRuntime } from "@n0n/core";
import { buildLLMConfigFromEnv, createLLMClient } from "@n0n/llm";
import { startScheduler } from "@n0n/scheduler";
import { ensureDirs } from "@n0n/shared";
import { resolveWorkflowPaths } from "@n0n/workflow";

const workspace =
	process.env.N0N_SCHEDULER_WORKSPACE ?? `${process.cwd()}/.runtime/scheduler`;
const paths = resolveWorkflowPaths(workspace);
ensureDirs(paths);
const llmConfig = buildLLMConfigFromEnv("LLM");
const editorLlmConfig = buildLLMConfigFromEnv(
	"EDITOR_LLM",
	llmConfig.providerConfig,
);
const runtime = createRuntimeContext({
	client: createLLMClient(llmConfig),
	editBackend: {
		type: "str-replace",
		editorClient: createLLMClient(editorLlmConfig),
	},
});
initRuntime(runtime);

startScheduler(paths).catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
