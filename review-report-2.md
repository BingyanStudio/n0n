apps/feishu/src/index.ts
Comment on lines +48 to +60
	const schedulerPaths = initConfig({
		workspace: resolve(process.cwd(), ".runtime", "feishu", "scheduler"),
		workflows: "workflows",
		tasks: "workflows/tasks",
		skills: "workflows/skills",
		schedules: "workflows/schedules",
		memory: "workflows/memory",
		consultResult: "workflows/consult-result",
		history: "workflows/history",
		temp: ".temp",
	});

	await startScheduler(schedulerPaths);
Copilot AI
3 minutes ago
Feishu initializes global core/tools config once for the scheduler workspace (.runtime/feishu/scheduler). Per-user sessions compute workspacePaths, but agentLoop runs with the global tools config, so exec defaults (cwd/temp) will still point at the scheduler workspace rather than session.paths.workspace. This breaks per-user workspace isolation for tool execution. A fix likely needs a per-session tools config (e.g., pass a tools/workspace override into agentLoop/tool execution, or set/restore tools config around each round with appropriate concurrency protection).

Suggested change
	const schedulerPaths = initConfig({
		workspace: resolve(process.cwd(), ".runtime", "feishu", "scheduler"),
		workflows: "workflows",
		tasks: "workflows/tasks",
		skills: "workflows/skills",
		schedules: "workflows/schedules",
		memory: "workflows/memory",
		consultResult: "workflows/consult-result",
		history: "workflows/history",
		temp: ".temp",
	});
	await startScheduler(schedulerPaths);
	// 为避免 scheduler 的 workspace 污染全局 tools 配置，这里仅在显式开启调度器时运行。
	let schedulerPaths;
	if (process.env.FEISHU_RUN_SCHEDULER === "1") {
		schedulerPaths = initConfig({
			workspace: resolve(process.cwd(), ".runtime", "feishu", "scheduler"),
			workflows: "workflows",
			tasks: "workflows/tasks",
			skills: "workflows/skills",
			schedules: "workflows/schedules",
			memory: "workflows/memory",
			consultResult: "workflows/consult-result",
			history: "workflows/history",
			temp: ".temp",
		});
		await startScheduler(schedulerPaths);
	}
Copilot uses AI. Check for mistakes.
@XiaoLinXiaoZhu	Reply...
packages/tools/src/exec.ts
Comment on lines 211 to 213
	const runtime = args.runtime ?? DEFAULT_RUNTIME;
	const cwd = args.cwd ?? PROJECT_ROOT;
	const cwd = resolve(args.cwd ?? getToolsConfig().workspace);
	const timeoutMs = (args.timeout ?? 120) * 1000;
Copilot AI
3 minutes ago
execToolStream resolves cwd with resolve(args.cwd ?? getToolsConfig().workspace). If the model passes a relative cwd (e.g. src), path.resolve() will interpret it relative to the current process working directory, not the injected workspace. This breaks the workspace-driven default semantics. Resolve relative paths against getToolsConfig().workspace (keep absolute paths as-is).

Copilot uses AI. Check for mistakes.
@XiaoLinXiaoZhu	Reply...
packages/tools/src/submit.ts
Comment on lines 116 to 117
	const schemaRequired = (jsonSchema.required as string[]) ?? [];

Copilot AI
3 minutes ago
schemaRequired is read only from jsonSchema.required. For discriminated unions (oneOf/anyOf) Zod typically places required on each variant, so the tool schema may end up with an empty required array even though the discriminator (e.g. type) is mandatory. This makes the model more likely to omit required fields and rely on retry-on-validation-failure. Consider deriving required from the union variants (e.g., intersection of variant required arrays to at least require the discriminator) when top-level required is missing.

Suggested change
	const schemaRequired = (jsonSchema.required as string[]) ?? [];
	// 从 JSON Schema 顶层读取 required；若缺失且为 discriminated union，则从各 variant 的 required 求交集
	let schemaRequired: string[] =
		Array.isArray((jsonSchema as { required?: unknown }).required)
			? ([...(jsonSchema as { required: string[] }).required] as string[])
			: [];
	if (schemaRequired.length === 0) {
		const unionKey = Array.isArray(
			(jsonSchema as { oneOf?: unknown }).oneOf,
		)
			? "oneOf"
			: Array.isArray((jsonSchema as { anyOf?: unknown }).anyOf)
				? "anyOf"
				: null;
		if (unionKey) {
			const variants = (jsonSchema as Record<string, unknown>)[
				unionKey
			] as Array<{ required?: unknown }> | undefined;
			if (Array.isArray(variants) && variants.length > 0) {
				const variantRequiredArrays = variants
					.map((v) =>
						Array.isArray(v.required)
							? (v.required as string[])
							: [],
					)
					.filter((arr) => arr.length > 0);
				if (variantRequiredArrays.length > 0) {
					const intersection = variantRequiredArrays.reduce(
						(acc, arr) =>
							acc.filter((key) => arr.includes(key)),
					);
					if (intersection.length > 0) {
						schemaRequired = intersection;
					}
				}
			}
		}
	}
Copilot uses AI. Check for mistakes.
@XiaoLinXiaoZhu	Reply...
packages/core/src/config.ts
Comment on lines +100 to +110
 * @deprecated 旧版全局路径配置，保持向后兼容，建议逐步迁移到显式路径配置。
 */
export const lagacy_paths = resolvePaths();

/** 最近一次 initConfig 解析出的路径（反映当前全局配置状态） */
let _currentPaths: WorkspacePaths = lagacy_paths;

/**
 * 获取当前全局配置对应的工作区路径。
 *
 * 与 `lagacy_paths`（模块加载时快照）不同，此函数返回最近一次
Copilot AI
3 minutes ago
The exported constant is named lagacy_paths (typo). Since it’s used as a default parameter value across modules and is also re-exported as paths, the misspelling is easy to propagate and makes the API harder to read/search. Rename to legacy_paths (and update imports) while keeping the public paths alias if needed for compatibility.

Suggested change
 * @deprecated 旧版全局路径配置，保持向后兼容，建议逐步迁移到显式路径配置。
 */
export const lagacy_paths = resolvePaths();
/** 最近一次 initConfig 解析出的路径（反映当前全局配置状态） */
let _currentPaths: WorkspacePaths = lagacy_paths;
/**
 * 获取当前全局配置对应的工作区路径。
 *
 * 与 `lagacy_paths`（模块加载时快照）不同，此函数返回最近一次
 * 旧版全局路径配置，保持向后兼容，建议逐步迁移到显式路径配置。
 */
export const legacy_paths = resolvePaths();
/**
 * @deprecated 请使用 `legacy_paths`。此别名仅为向后兼容保留。
 */
export const lagacy_paths = legacy_paths;
/** 最近一次 initConfig 解析出的路径（反映当前全局配置状态） */
let _currentPaths: WorkspacePaths = legacy_paths;
/**
 * 获取当前全局配置对应的工作区路径。
 *
 * 与 `legacy_paths`（模块加载时快照）不同，此函数返回最近一次
Copilot uses AI. Check for mistakes.
@XiaoLinXiaoZhu	Reply...
packages/core/src/scheduler/scheduler.ts
Comment on lines +107 to 115
export async function startScheduler(
	paths: SchedulerPaths = lagacy_paths,
): Promise<void> {
	if (running) return;
	running = true;

	console.log(
		`[scheduler] Started. Watching ${SCHEDULES_DIR}/*.mdc every 60s.`,
		`[scheduler] Started. Watching ${paths.schedules}/*.mdc every 60s.`,
	);
Copilot AI
3 minutes ago
startScheduler now accepts injected paths, but it only types/uses schedules. When triggering entries it calls runWorkflow(entry.workflow) and delegateTask(entry.prompt) without propagating the same workspace configuration. In workspaces where process.cwd() != workspace root (e.g. Feishu scheduler), schedule frontmatter like workflow: workflows/tasks/xxx.ts will be resolved against the wrong base and can fail. Consider expanding SchedulerPaths to include workspace (and optionally tasks/temp), then resolve workflow paths relative to that workspace and call delegateTask with the same path/workspace config.

Copilot uses AI. Check for mistakes.