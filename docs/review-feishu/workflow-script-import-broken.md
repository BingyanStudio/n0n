# Workflow 脚本在用户 Workspace 中无法导入模块

## 问题描述

Agent 为飞书用户编写的 workflow 脚本（如 `workflows/tasks/greet.ts`）在用户 workspace 中通过 `bun run` 执行时，**无法导入 `@n0n/*` 包和 skill 模块**，因为用户 workspace 缺少必要的模块解析配置。

## 实际行为

### 用户 Workspace 环境

用户 workspace 位于 `.runtime/feishu/<senderOpenId>/`，该目录下：

- ❌ 没有 `package.json`
- ❌ 没有 `tsconfig.json`
- ❌ 没有 `node_modules/`
- ❌ 没有 `bunfig.toml`

### 模块解析失败场景

**场景 A：导入 @n0n 包**

Agent 按 `feishu.md` prompt 中的指导编写 workflow：

```typescript
// workflows/tasks/greet.ts
import { generate } from "@n0n/core";  // ❌ 会失败
```

`bun` 从 cwd（`.runtime/feishu/<userId>/`）向上查找 `node_modules`，但 `.runtime/` 目录和 `.runtime/feishu/` 目录下都没有 `node_modules`。虽然项目根目录有 `node_modules`，但 bun 的模块解析不一定能到达那里（取决于目录层级和 workspace 配置）。

根目录 `tsconfig.json` 的 `paths` 映射了 `@n0n/*`，但这个 tsconfig 只在从项目根执行时有效，不会影响从用户 workspace 启动的 bun 进程。

**场景 B：导入 Skill 脚本**

Skill 目录在 workspace 外（绝对路径 `.runtime/feishu/shared/skills/`）：

```typescript
// Agent 可能这样写：
import { createFeishuClient } from "../skills/feishu-bot/scripts/lib.ts";  // ❌ 路径错误
```

prompt 中 `buildFeishuCapabilityContext` 引导模型使用 `workflows/skills/feishu-bot`（相对路径），但飞书模式下 skills 不在 workspace 内部的 `workflows/skills/` 下，而是在共享目录 `shared/skills/`（绝对路径）。

即使 Agent 使用绝对路径导入：
```typescript
import { createFeishuClient } from "/abs/path/.runtime/feishu/shared/skills/feishu-bot/scripts/lib.ts";
```
skill 脚本自身可能依赖 `@larksuiteoapi/node-sdk` 等 npm 包，这些包同样面临 `node_modules` 解析问题。

## 为什么这是问题

1. **核心功能不可用**：飞书 prompt 的 `<specification>` 部分引导 Agent 使用 `import { generate } from "@n0n/core"` 编写 workflow，但实际执行会报 `ModuleNotFoundError`
2. **Skill 脚本不可用**：`feishu-bot` 等 skill 的脚本依赖 npm 包（`@larksuiteoapi/node-sdk`），在用户 workspace cwd 下无法解析
3. **prompt 与实际不一致**：`buildFeishuCapabilityContext` 引导使用 `workflows/skills/feishu-bot`（相对路径），但飞书模式下 skills 实际在共享绝对路径

## 复现路径

```bash
# 模拟 Agent 执行环境
cd .runtime/feishu/<任意userId>/
echo 'import { generate } from "@n0n/core"; console.log("ok");' > test.ts
bun run test.ts
# 预期：ModuleNotFoundError: Cannot find package "@n0n/core"
```

## 相关代码

| 文件 | 说明 |
|------|------|
| `apps/feishu/src/round.ts` L118-121 | `toolsWorkspace` 设置 cwd 为用户 workspace |
| `apps/feishu/src/round.ts` L44-52 | `buildFeishuCapabilityContext` 使用错误的相对路径 |
| `apps/feishu/src/session.ts` L211 | 注入 skills 绝对路径 |
| `packages/tools/src/exec.ts` | exec 工具以 workspace 为 cwd 执行脚本 |
| `tsconfig.json` | `paths` 映射 `@n0n/*`，仅从项目根有效 |
| `package.json` | `workspaces` 只包含 `packages/*` 和 `apps/*` |
