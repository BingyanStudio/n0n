# 代码审查报告：接口模块层级问题

**审查日期**: 2026-03-08  
**审查范围**: @n0n/core, @n0n/llm, @n0n/tools, apps/feishu, apps/cli, apps/code  
**审查重点**: 
1. 纯工具函数混入副作用或回退逻辑
2. 多个模块的关注点混合（宽接口、上帝类型）

---

## 执行摘要

**总体评估**: 代码库架构清晰，分层合理，但存在若干接口层级问题影响可维护性。

**关键发现**:
1. ✅ **良好设计**: 核心模块 DomainMessage 设计、工具注册表模式、配置注入机制均符合最佳实践
2. ⚠️ **中等问题**: 配置模块存在隐式全局状态、部分工具函数接受过多可选参数
3. 🔴 **需改进**: `delegateTask` 和 `generate` 存在副作用（修改全局配置）、路径配置职责不清晰

**影响范围**: 主要影响应用启动流程和多租户隔离场景（如飞书 Bot）。

---

## 一、核心模块 (@n0n/core)

### 1.1 发现的问题

#### 问题 1：配置管理的副作用混入 ⚠️

**位置**: `packages/core/src/task/delegate.ts`, `packages/core/src/task/generate.ts`

**问题描述**:
```typescript
// delegateTask 内部调用 initToolsConfig，修改全局状态
if (options?.pathConfig) {
    initToolsConfig({ ... }); // 副作用！
}
```

**影响**:
- 破坏函数纯度，外部调用者无法预期副作用
- 多次调用 `delegateTask` 可能互相干扰
- 测试时难以隔离状态

#### 问题 2：路径解析职责不清晰 ⚠️

**位置**: `packages/core/src/config.ts`

**问题描述**:
- `resolvePaths()` 是纯函数，但 `initConfig()` 同时做了三件事：
  1. 解析路径
  2. 存储到模块变量 `_currentPaths`
  3. 初始化子包配置（`initLLMConfig`, `initToolsConfig`）

**影响**:
- 职责过重，违反单一职责原则
- `getCurrentPaths()` 依赖隐式全局状态

### 1.2 建议改进

**改进方案 1**:  将配置副作用提升到调用侧
```typescript
// delegateTask 应该只接受已解析的 paths，不负责修改全局配置
export async function delegateTask<T>(
    query: string,
    paths: WorkspacePaths, // 必需参数，不再可选
    options?: { schema?: ZodType<T>; maxIterations?: number; }
): Promise<TaskResult<T>>
```

**改进方案 2**: 移除隐式全局状态
```typescript
// 避免 _currentPaths，让调用方显式管理 WorkspacePaths
// 或使用 Context 对象传递，而非模块级变量
```

---

## 二、LLM 模块 (@n0n/llm)

### 2.1 发现的问题

#### 问题 1：配置初始化的异常处理不一致 ⚠️

**位置**: `packages/llm/src/config.ts`

**问题描述**:
```typescript
export function getLLMConfig(): LLMConfig {
    if (!_config) {
        throw new Error("LLM config not initialized...");
    }
    return _config;
}
```

**影响**:
- 运行时错误而非编译时检查
- 调用方需要理解初始化顺序
- 与 `@n0n/tools` 的 `getToolsConfig()` 行为不一致（tools 有默认值）

#### 优点：配置注入模式设计良好 ✅

- 配置通过 `initLLMConfig()` 注入，不直接读取环境变量
- LLM 模块本身不依赖 `process.env`，利于测试和复用
- 接口简洁：只导出 `LLMConfig` 类型和初始化函数

### 2.2 建议改进

**改进方案**:  提供默认值或使用 Option 类型
```typescript
// 方案 A: 提供默认配置（用于测试）
let _config: LLMConfig = {
    baseUrl: "http://localhost:11434",
    apiKey: "",
    model: "test",
};

// 方案 B: 返回可选类型，由调用方处理
export function getLLMConfig(): LLMConfig | null {
    return _config;
}
```

---

## 三、工具模块 (@n0n/tools)

### 3.1 发现的问题

#### 问题 1：exec 工具参数过多可选项 ⚠️

**位置**: `packages/tools/src/exec.ts`

**问题描述**:
```typescript
export const ExecArgsSchema = z.object({
    script: z.string(),
    runtime: z.string().optional(),     // 可选
    cwd: z.string().optional(),         // 可选
    timeout: z.number().optional(),     // 可选
});
```

**影响**:
- LLM 需要理解 4 个参数的默认值和回退逻辑
- 工具描述文本冗长（120+ 行）
- 增加 token 消耗和模型理解难度

#### 问题 2：confirmFn 回退混入工具执行器 ⚠️

**位置**: `packages/tools/src/exec.ts:handleBlockedCommand()`

**问题描述**:
- `execToolStream` 接受可选的 `confirmFn`
- 当 `confirmFn` 不存在时，工具内部决定"拒绝执行"
- 这是一种隐式的回退逻辑

**影响**:
- 工具执行器承担了策略决策（应该由上层决定）
- 外部调用方需要理解"无 confirmFn = 自动拒绝"的语义

#### 优点：工具注册表设计优秀 ✅

- `makeToolkit()` 清晰分离了定义和执行
- `ToolsWorkspaceOverride` 实现了 per-session 隔离
- `ToolEntry` 的 stream/sync 区分合理

### 3.2 建议改进

**改进方案 1**: 减少可选参数
```typescript
// 将默认值提升到调用侧或配置层
export interface ExecToolConfig {
    defaultRuntime: string;
    defaultTimeout: number;
}

// 工具只接受必需参数
export const ExecArgsSchema = z.object({
    script: z.string(),
    runtime: z.string(),  // 必需
    // cwd 从 workspace 推导，不暴露给 LLM
});
```

**改进方案 2**: 提升确认策略
```typescript
// 在工具注册时决定策略，而非执行时
interface ToolExecutionPolicy {
    onBlockedCommand: "reject" | "confirm" | "allow";
}
```

---

## 四、应用层 (apps/*)

### 4.1 发现的问题

#### 问题 1：飞书应用的配置管理混乱 🔴

**位置**: `apps/feishu/src/index.ts`

**问题描述**:
```typescript
// 全局初始化 scheduler 的 workspace
const schedulerPaths = initConfig({ workspace: "..." });
await startScheduler(schedulerPaths);

// 每个用户 session 有独立的 workspace
const workspacePaths = resolveFeishuPaths(ctx.senderOpenId);
const session = getOrCreateSession(..., workspacePaths);
```

**影响**:
- `initConfig()` 被调用了两次（全局一次 + delegateTask 内部可能再次调用）
- 全局 `_currentPaths` 被覆盖，scheduler 可能使用错误的路径
- 多租户隔离不彻底

#### 问题 2：CLI 入口的路径解析重复 ⚠️

**位置**: `apps/cli/src/index.ts`

**问题描述**:
```typescript
// 在 main() 外部就解析了一次，为了在 cleanup handler 中使用
const _resolved = resolveCliWorkspacePaths(process.argv.slice(2));

async function main() {
    const args = _resolved.args;
    const workspacePaths = _resolved.workspacePaths;
    // ...
}
```

**影响**:
- 模块级副作用，影响测试
- 路径解析逻辑与应用生命周期耦合

#### 优点：应用层职责分离良好 ✅

- `apps/cli`: 纯粹的用户交互和命令路由
- `apps/code`: 专注代码编写场景
- `apps/feishu`: 清晰的事件分发和会话管理

### 4.2 建议改进

**改进方案 1**: 移除全局 `_currentPaths`
```typescript
// 让每个应用显式管理自己的 WorkspacePaths
// scheduler 接受显式的 paths 参数，不依赖全局状态

export async function startScheduler(
    paths: SchedulerPaths,
    config?: { llm: LLMConfig }
): Promise<void> {
    // 不再调用 getCurrentPaths()
}
```

**改进方案 2**: 飞书应用使用 Context 对象
```typescript
interface FeishuAppContext {
    bot: FeishuBot;
    schedulerPaths: WorkspacePaths;
    llmConfig: LLMConfig;
}

// 在应用启动时创建一次，传递给各模块
const appContext = createFeishuAppContext();
```

---

## 五、优先级建议

### P0 - 关键问题（影响正确性）

1. **修复飞书应用的配置冲突** 🔴
   - 问题：全局 `_currentPaths` 可能被覆盖，影响 scheduler 和 session 隔离
   - 方案：移除全局状态，使用显式的 Context 对象
   - 影响范围：`apps/feishu`, `packages/core/src/config.ts`
   - 预计工作量：2-3 小时

### P1 - 重要改进（影响可维护性）

2. **重构 `delegateTask` 和 `generate` 的配置管理** ⚠️
   - 问题：内部调用 `initToolsConfig()` 是副作用，破坏函数纯度
   - 方案：将 `WorkspacePaths` 作为必需参数，移除 `pathConfig` 可选参数
   - 影响范围：`packages/core/src/task/*`, 所有调用方
   - 预计工作量：1-2 小时

3. **简化 exec 工具的参数接口** ⚠️
   - 问题：4 个可选参数增加 LLM 理解难度
   - 方案：将 `runtime` 和 `timeout` 移到配置层，减少工具描述长度
   - 影响范围：`packages/tools/src/exec.ts`
   - 预计工作量：1 小时

### P2 - 优化建议（改善开发体验）

4. **统一配置初始化错误处理** ⚠️
   - 问题：`getLLMConfig()` 抛异常，`getToolsConfig()` 返回默认值
   - 方案：统一为"提供默认值"或"返回 Option 类型"
   - 影响范围：`packages/llm/src/config.ts`, `packages/tools/src/config.ts`
   - 预计工作量：30 分钟

5. **提升 confirmFn 策略到工具注册层** ⚠️
   - 问题：确认逻辑混入工具执行器
   - 方案：在 `makeToolkit()` 时配置策略
   - 影响范围：`packages/tools/src/index.ts`, `packages/tools/src/exec.ts`
   - 预计工作量：1 小时

### 实施建议

**第一阶段（1-2 天）**: 修复 P0 和 P1 问题
- 优先处理飞书应用的配置冲突（影响正确性）
- 重构 `delegateTask` 的接口设计
- 更新相关文档和测试

**第二阶段（1 天）**: 完成 P2 优化
- 简化工具接口
- 统一错误处理
- 提升策略层级

**持续改进**:
- 增加集成测试，覆盖多租户场景
- 编写配置管理最佳实践文档
- 定期审查新增的可选参数

---

## 附录：审查方法论

本次审查基于以下原则：
- **单一职责原则**：每个函数/模块应只做一件事
- **接口最小化**：避免可选参数过多，减少认知负担
- **关注点分离**：业务逻辑、配置、副作用应分层
- **依赖方向**：底层不应依赖上层，核心不应依赖特定实现
