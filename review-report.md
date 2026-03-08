## issue 1

packages\core\src\workflow\runtime.ts:71-100
```ts
/**
 * 执行一个 workflow 文件
 */
export async function runWorkflow(
	workflowPath: string,
	args?: unknown,
): Promise<unknown> {
	const absPath = resolve(workflowPath);

	if (!existsSync(absPath)) {
		throw new Error(`Workflow not found: ${workflowPath}`);
	}

	// Bun 原生支持动态 import .ts 文件
	const mod = (await import(absPath)) as WorkflowModule;

	// 查找入口函数：优先 default export，其次 named export `run`
	const entryFn = mod.default ?? mod.run;

	if (typeof entryFn !== "function") {
		const exports = Object.keys(mod).filter((k) => k !== "__esModule");
		throw new Error(
			`Workflow ${workflowPath} must export a default function or a named 'run' function.\n` +
				`Found exports: [${exports.join(", ")}]\n` +
				`See WorkflowModule interface in @n0n/core for the expected contract.`,
		);
	}

	return entryFn(args);
}
```

这个为什么执行的时候不需要传递 workplacepath？如果是这样的话，假设文件执行：

```ts
/**
 * CSV 数据异常分析
 *
 * 演示：exec + 数据处理
 * 用法：CSV_PATH=data/sample.csv bun run src/main.ts run workflows/tasks/csv-analysis.ts
 */

import { delegateTask } from "@n0n/core";

export default async function run() {
	const csvPath = process.env.CSV_PATH ?? "data/sample.csv";

	const result = await delegateTask(
		`Analyze the CSV file at "${csvPath}" for anomalies. Read it, understand its structure, identify outliers/missing values/format errors. If the file doesn't exist, create sample data first. Submit a structured analysis report.`,
	);

	console.log(result.result);
	return result.result;
}
```

这里的 delegateTask 的 workplacePath 是什么？

期望行为：当不传递 workplacePath 时，delegateTask 应该使用 调用其的 workplacePath 作为默认值。也就是说，在假设父进程（cli或者fieshu）的 workspace 为 `.runtime/xxx` 目录，那么 delegateTask 的 workplacePath 也应该默认是 `.runtime/xxx`，除非显式传递了其他路径。

## issue 2

in apps/feishu/src/card-actions.ts：

```
	return initConfig({
		workspace: resolve(process.cwd(), ".runtime", "feishu", senderOpenId),
		workflows: "workflows",
		tasks: "workflows/tasks",
		skills: "workflows/skills",
		schedules: "workflows/schedules",
		memory: "workflows/memory",
		consultResult: "workflows/consult-result",
		history: "workflows/history",
		temp: ".temp",
	});
```

This handler derives `workspacePaths` via `initConfig(...)`, which reinitializes global config. Card actions can therefore change the workspace seen by other in-flight sessions/scheduler tasks. Use a side-effect-free path resolver here and avoid calling `initConfig` in per-request code paths.
```suggestion
	const workspace = resolve(process.cwd(), ".runtime", "feishu", senderOpenId);

	return {
		workspace,
		workflows: resolve(workspace, "workflows"),
		tasks: resolve(workspace, "workflows", "tasks"),
		skills: resolve(workspace, "workflows", "skills"),
		schedules: resolve(workspace, "workflows", "schedules"),
		memory: resolve(workspace, "workflows", "memory"),
		consultResult: resolve(workspace, "workflows", "consult-result"),
		history: resolve(workspace, "workflows", "history"),
		temp: resolve(workspace, ".temp"),
	};
```

## issue 3

in packages/core/src/task/delegate.ts:

```
	const resolvedPaths = options?.pathConfig
		? resolvePaths(options.pathConfig)
		: paths;
	const allSkills = await discoverSkills(resolvedPaths.skills);
	const skillSummaryText = formatSkillSummaries(allSkills);
```

`delegateTask` can accept `pathConfig` and compute `resolvedPaths`, but this doesn’t align the global tools config that `exec`/`getEnvInfo()` rely on. If callers pass `pathConfig` without separately calling `initConfig`, tool execution will still default to the previously initialized workspace. Consider either documenting that `initConfig` must be called upstream, or making this function apply the config it receives.

and
```
	const env = getEnvInfo();
	const envLine = `Environment: OS=${env.os}, Shell=${env.shell}, CWD=${env.cwd}`;
```

`envLine` is built from `getEnvInfo()` (global tools config) rather than `resolvedPaths.workspace`. When `resolvedPaths` differs from the global config, the prompt will advertise the wrong CWD and `exec` will likely run in the wrong place. Prefer using `resolvedPaths.workspace` (and ensuring tools config matches it) for the CWD reported to the model.


## issue 4

in apps/cli/src/index.ts:

```
const processWorkspacePaths = resolveCliWorkspacePaths(
	process.argv.slice(2),
).workspacePaths;
```

`resolveCliWorkspacePaths()` (which calls `initConfig`) is executed again just to wire cleanup handlers. This re-parses args and reinitializes global config a second time. Prefer computing `workspacePaths` once and reusing it for both `main()` and `cleanupTemp`.


## issue 5

in packages/core/src/workflow/runtime.ts
```
function resolveFeishuWorkspace(senderOpenId: string) {
	return initConfig({
		workspace: resolve(process.cwd(), ".runtime", "feishu", senderOpenId),
		workflows: "workflows",
		tasks: "workflows/tasks",
```

`resolveFeishuWorkspace` calls `initConfig(...)` per event. `initConfig` mutates global tool/LLM config, so concurrent sessions (and the scheduler initialized earlier) can race and run tools with the wrong workspace/cwd/temp. Prefer a pure path resolver for per-user workspaces, and avoid reinitializing global config inside request handlers.

# finished

## issue 0

将所有 `workplacePaths` 重命名为了 `paths` 因为他们只是 `Pick<WorkplacePaths, key>`,仅仅索要自己需要的路径，而不是整个对象。并且在函数参数中直接传递 `paths` 对象，而不是单独传递 `workplacePath`，这样可以避免混淆和冗余。