# Workspace Isolation 重做指南

## 基准分支

从 `1258500` (feat: extract cli-ui package + scaffold code agent app) 重新开始。

## 可 cherry-pick 的独立修复

- `a5110f6` — code app PROMPT_PATH Windows 路径修复（`new URL().pathname` → `resolve(import.meta.dir)`）

## 需要重做的部分

### 1. submit 工具 oneOf 扁平化

当前实现（`f92bba1` + `3fba472`）存在问题：

**问题根因**：`makeSubmitToolDefinition` 用 `toJSONSchema(schema)` 转换 Zod schema，然后从顶层提取 `properties`。但 `z.discriminatedUnion` 生成的 JSON Schema 是 `oneOf` 结构，顶层没有 `properties`，导致 LLM 看到空参数。

**第一次修复尝试的问题**：
- 合并所有 oneOf 分支的 properties 到扁平 object
- 但没有考虑同名字段在不同分支有不同 description 的情况（如 `InteractiveResultSchema` 中 `message` 在 `chat` 和 `need_info` 分支各有不同含义）
- 用户指出后，尝试了复杂的 description 合并逻辑（按分支标注来源），代码臃肿且脆弱

**第二次修复（用户纠正后）**：
- 用户指出：参数不要传 description，在工具 description 中统一描述格式
- 改为：parameters 只保留类型信息，剥离所有 description；完整 schema（含 description）放在工具的 description 字段中
- 这个方向是对的，但实现仍有改进空间

**反思**：
- 一开始就应该意识到 `oneOf` 在 LLM tool calling 中不可靠，这是已知的行业共识
- 应该在写 `makeSubmitToolDefinition` 时就考虑 discriminatedUnion 的情况，而不是等到运行时报错才发现
- description 冲突问题本质上是“扁平化必然丢失结构信息”，正确做法是不在参数层面解决，而是在工具描述中保留完整结构

### 2. workspace isolation 核心设计

**第一次实现的问题**：
- 采用参数透传后，出现了 16 个文件的霰弹式修改
- 后续文档又错误建议使用 `Workspace` 类封装；该指导现已确认不正确
- 没有区分 code agent 的“项目目录”和“运行时数据目录”
- `exec` 工具的默认 cwd 仍然是 `process.cwd()` 硬编码，没有配置驱动
- `tempDir` 没有跟随 workspace
- `initToolsConfig` 没有接收 workspace

**用户多次纠正但被忽略的点**：
1. “为什么不是基于 workspace 的？” — AGENTS.md 应从 workspace 读取，不是 `process.cwd()`
2. “--cwd 改为 workspace” — 用户明确要求统一为 workspace 语义
3. “CLI 也支持指定 workspace” — 用户原话包含此要求，被遗漏
4. “exec 执行时默认目录也应该基于 workspace” — 被遗漏
5. “tempDir 应该通过 paths 传递” — 被遗漏
6. “不要用 process.cwd()，用配置驱动” — 被忽略后又用了 `process.chdir()` 这种全局副作用

**三个 app 的 workspace 语义（用户最终澄清）**：
- **CLI**：`.runtime/workflows` 是完整工作环境（tasks/skills/memory + exec cwd）
- **Feishu**：`.runtime/feishu/<senderOpenId>` 同上，per-user 隔离
- **Code**：`--workspace` 指向目标项目目录，code agent 不使用 tasks/skills/memory，`.runtime/code` 仅为测试默认值

**修正后的设计方向**：
- 保留 `resolvePaths(workspace)` 作为路径解析入口
- 使用“函数参数注入 / 小配置对象注入”，不要再引入 `Workspace` 类
- 每个函数只接收自己真正需要的路径
- `exec` 默认 cwd、AGENTS.md、`tempDir` 均通过显式配置传递
- app 层负责根据自身语义构造并传递配置

### 3. workflows/ 清理

- `workflows/` 需要从 git 跟踪移除（`git rm -r --cached`）
- `.gitignore` 加入 `workflows/`
- 设计文档要求 `git filter-repo --path workflows/ --invert-paths` 清理历史（破坏性操作，需确认）

## 架构建议（修正版）

不要再按 `Workspace` 类方向实现。

核心思路：
```ts
const paths = resolvePaths(workspaceDir);

await discoverWorkflows({ tasksDir: paths.tasks, skillsDir: paths.skills });
await loadSchedules({ schedulesDir: paths.schedules });
await ragSearch(query, space, {
  skillsDir: paths.skills,
  memoryDir: paths.memory,
  consultResultDir: paths.consultResult,
  historyDir: paths.history,
});

initToolsConfig({
  workspace: workspaceDir,
  tempDir: paths.temp,
  // ...
});
```

原则：最小接口、显式依赖、配置驱动，不依赖 `process.cwd()`。
