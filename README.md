# n0n

> 自然语言驱动的 AI Agent 工作流引擎 — 用对话创建、运行、调度可复用的 TypeScript 工作流。

## 核心理念

- **代码即工作流** — 不用拖拽式 DAG，直接用 TypeScript 编写 workflow
- **AI 自动创建** — 描述任务 → Agent 编写 `.ts` → 运行验证 → 迭代修正 → 交付可复用 workflow
- **自扩展** — 每个 `.ts` 文件就是一个 skill，`import`/`export` 即组合
- **文件系统即注册表** — `workflows/skills/` 和 `workflows/tasks/` 即发现机制

## 项目结构

Turborepo monorepo，4 个共享包 + 3 个应用：

```
packages/
  types/       领域消息类型（DomainMessage 判别联合）
  llm/         LLM 客户端 + SSE 流式 + DomainMessage → API 消息适配
  tools/       统一工具注册表（exec / write / reminder / submit）+ Zod 运行时校验
  core/        Agent Loop · delegateTask · generate · RAG · Scheduler · Workflow 运行时
apps/
  cli/         交互式终端 — REPL + 富文本流式渲染
  feishu/      飞书 Bot 服务 — WebSocket 长连接 + 流式卡片渲染
  scheduler/   定时调度器 — cron 驱动 workflow 执行
```

### 包依赖关系

```
cli / feishu / scheduler
        ↓
      core  ←  tools
     ↙    ↘      ↓
   llm    types ←─┘
```

| 包 | 职责 |
|---|---|
| `@n0n/types` | 零依赖的领域类型：`DomainMessage` 判别联合、`Renderer` 接口、LLM 类型 |
| `@n0n/llm` | LLM 客户端封装：`chatCompletion` / `chatCompletionStream`（SSE）、`StreamAccumulator`、消息适配器 |
| `@n0n/tools` | 工具注册表：`exec`（命令执行）、`write`（文件读写）、`reminder`（OKR 备忘）、`submit`（结果提交）；参数通过 Zod schema 运行时校验 |
| `@n0n/core` | 核心引擎：`agentLoop`（底层循环）、`generate`（轻量生成）、`delegateTask`（完整流水线：咨询→RAG→执行）、Scheduler、Workflow 运行时、Skill/Workflow 发现 |

## 快速开始

```bash
# 安装依赖
bun install

# 创建 .env（必需）
cat > .env << 'EOF'
LLM_BASE_URL=https://api.example.com
LLM_API_KEY=sk-xxx
LLM_MODEL=deepseek/deepseek-v3.2
EOF

# 交互式对话
bun start

# 直接传入任务
bun start "帮我每天早上总结 Hacker News 热门"
```

## CLI 命令

```bash
# 交互式 REPL（默认）
bun start

# 运行已有 workflow
bun run apps/cli/src/index.ts run <workflow.ts>

# 列出所有 workflow
bun run apps/cli/src/index.ts workflows

# 查看定时任务
bun run apps/cli/src/index.ts schedule list

# 启动飞书 Bot（独立进程）
bun run apps/feishu/src/index.ts

# 启动定时调度器（独立进程）
bun run apps/scheduler/src/index.ts
```

## 环境变量

### LLM（必需）

| 变量 | 必需 | 默认值 | 说明 |
|---|---|---|---|
| `LLM_BASE_URL` | ✅ | — | OpenAI 兼容 API 地址 |
| `LLM_API_KEY` | ✅ | — | API 密钥 |
| `LLM_MODEL` | ✅ | — | 模型标识，如 `deepseek/deepseek-v3.2` |
| `LLM_ENABLE_THINKING` | | `false` | 设为 `true` 启用 DeepSeek extended thinking |

### 飞书 Bot（仅 `apps/feishu` 需要）

| 变量 | 必需 | 默认值 | 说明 |
|---|---|---|---|
| `FEISHU_APP_ID` | ✅ | — | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | ✅ | — | 飞书应用 App Secret |
| `FEISHU_ENCRYPT_KEY` | | — | 事件订阅加密密钥 |
| `FEISHU_DOMAIN` | | `feishu` | `feishu`（飞书）或 `lark`（海外） |

### 安全

| 变量 | 默认值 | 说明 |
|---|---|---|
| `BLOCKED_COMMANDS` | — | 逗号分隔的禁止执行命令，如 `rm -rf,shutdown` |

### 路径覆盖（均可选）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WORKFLOWS_DIR` | `workflows` | 工作流根目录 |
| `TASKS_DIR` | `workflows/tasks` | 任务 workflow 目录 |
| `SKILLS_DIR` | `workflows/skills` | 可复用 skill 目录 |
| `SCHEDULES_DIR` | `workflows/schedules` | 定时任务 `.mdc` 配置目录 |
| `MEMORY_DIR` | `workflows/memory` | 记忆 / 知识库目录 |
| `CONSULT_RESULT_DIR` | `workflows/consult-result` | 咨询结果缓存目录 |
| `HISTORY_DIR` | `workflows/history` | 历史记录目录 |

## 工作流程

```
用户："帮我分析这个 CSV 找出异常数据"
         ↓
   ┌─ Interactive REPL / 飞书 Bot ─┐
   │  解析用户意图，注入上下文      │
   └──────────┬───────────────────┘
              ↓
   ┌─ Agent Loop ─────────────────┐
   │  LLM ↔ 工具调用循环           │
   │  exec · write · reminder      │
   │  submit → Zod schema 校验     │
   │  最多 4 次重试                 │
   └──────────┬───────────────────┘
              ↓
   ✅ 可复用的 .ts workflow 文件
      workflows/tasks/csv-analysis.ts
```

### API 层级（由轻到重）

| API | 用途 |
|---|---|
| `generate<T>()` | 轻量生成 — 走 agentLoop 但跳过咨询 + RAG |
| `delegateTask<T>()` | 完整流水线 — 咨询 → RAG → agentLoop |
| `agentLoop<T>()` | 底层 API — 需要完全控制 `DomainMessage[]` |

## 技术栈

- **运行时** — [Bun](https://bun.sh)
- **语言** — TypeScript（strict mode）
- **Monorepo** — [Turborepo](https://turbo.build)
- **Lint** — [Biome](https://biomejs.dev)
- **Schema 校验** — [Zod](https://zod.dev)
- **飞书 SDK** — [@larksuiteoapi/node-sdk](https://github.com/larksuite/node-sdk)

## 开发

```bash
# 类型检查（全部包）
bun run typecheck

# Lint + 自动修复
bun run lint

# 单独启动某个 app
bun run apps/cli/src/index.ts
bun run apps/feishu/src/index.ts
bun run apps/scheduler/src/index.ts
```

## License

MIT
