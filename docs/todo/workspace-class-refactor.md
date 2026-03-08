# TODO: workspace 路径注入重构

## 背景

PR #35 实现了 workspace 隔离，但后续文档错误地把相关能力收敛到 `Workspace` 类。这个指导现在已确认需要撤回：它会把 discovery / scheduler / RAG / delegateTask 等能力绑定进一个宽接口对象，违反最小接口原则，也会掩盖真实依赖。

## 设计原则

1. **优先函数参数注入**：每个函数只接收它真正需要的路径或配置。
2. **避免宽接口对象**：不要为了少传几个参数，把无关能力塞进同一个类。
3. **避免全局隐式状态**：不要依赖 `process.cwd()`、`process.chdir()` 之类全局进程状态。
4. **配置驱动**：`exec` 默认 cwd、`tempDir`、AGENTS.md 读取位置都应由显式配置决定。
5. **按 app 语义建模**：CLI、Feishu、Code 的 workspace 语义不同，不能被同一个“完整工作空间对象”强行统一。

## 推荐方向

### 1. 定义小而清晰的路径配置

```ts
interface WorkspacePaths {
  root: string;
  tasks: string;
  skills: string;
  schedules: string;
  memory: string;
  consultResult: string;
  history: string;
  temp: string;
}
```

### 2. 由 app 层解析，再按需注入

```ts
const paths = resolvePaths(workspaceDir);
await discoverWorkflows(paths.tasks, paths.skills);
await loadSchedules(paths.schedules);
await ragSearch(query, space, {
  skillsDir: paths.skills,
  memoryDir: paths.memory,
  consultResultDir: paths.consultResult,
  historyDir: paths.history,
});
```

### 3. 按能力拆参数，而不是传万能对象

推荐：
- `discoverWorkflows({ tasksDir, skillsDir })`
- `loadSchedules({ schedulesDir })`
- `ragSearch(query, space, { skillsDir, memoryDir, consultResultDir, historyDir })`
- `initToolsConfig({ workspace, tempDir, ... })`

不推荐：
- `new Workspace(...).discoverWorkflows()`
- `new Workspace(...).loadSchedules()`
- `new Workspace(...).delegateTask()`

## 迁移策略

1. 保留 `resolvePaths(workspace)` 作为 app 层统一解析入口。
2. 将底层函数改为接收最小必需参数或小配置对象。
3. app 层负责把解析后的路径显式传入调用链。
4. `exec`、AGENTS.md、`tempDir` 改为读取显式 workspace/config，而不是 `process.cwd()`。
5. 只在确实存在稳定聚合边界时再引入对象封装，而不是预设 `Workspace` 类。

## 收益

1. **符合最小接口原则**：依赖关系直接体现在签名上。
2. **更易测试**：单个函数可以传入临时目录，不需要构造大对象。
3. **更少错误抽象**：避免一个类承担过多职责。
4. **语义更准确**：Code app 只注入项目目录相关配置，不被迫拥有 tasks/skills/memory 语义。

## 优先级

高 — 该文档用于指导重做，必须先修正，避免继续按错误方向实现。
