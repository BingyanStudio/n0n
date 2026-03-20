# n0n

> 自然语言驱动的 AI Agent 工作流引擎 — 用对话创建、运行、调度可复用的 TypeScript 工作流。

## 项目背景

本项目为华中科技大学 2026 年"智创未来"首届创意 AI 智能体校园开发大赛参赛作品（命题 C：自然语言驱动的工作流引擎）。

## 核心理念

- **代码即工作流** — 不用拖拽式 DAG，直接用 TypeScript 编写 workflow
- **AI 自动创建** — 描述任务 → Agent 编写 `.ts` → 运行验证 → 迭代修正 → 交付可复用 workflow
- **自扩展** — 每个 `.ts` 文件就是一个 skill，`import`/`export` 即组合
- **文件系统即注册表** — `workflows/skills/` 和 `workflows/tasks/` 即发现机制

## 架构

### Monorepo 结构

```
packages/
├── types/        领域消息类型（DomainMessage 判别联合）
├── llm/          LLM 客户端 + SSE 流式 + 多 Provider 支持
├── tools/        统一工具注册表（exec / write / edit / reminder / submit）
├── core/         Agent Loop 核心循环 + 运行时上下文
├── scheduler/    Cron 调度器
├── shared/       跨包共享工具（Skills 发现、Frontmatter、对话持久化）
├── workflow/     任务流水线（delegateTask / generate / RAG）
├── tui/          终端 UI 组件（React 渲染）
└── cli-ui/       共享终端 UI（富文本渲染、Live Region）

apps/
├── cli/          交互式终端 — Workflow Builder REPL
├── code/         代码编辑 Agent — 任意项目的代码变更
├── feishu/       飞书 Bot 服务 — WebSocket + 流式卡片渲染
├── fairy/        独立 Agent 应用
└── scheduler/    定时调度服务 — Cron 驱动 workflow 执行
```

### 包依赖关系

```
cli / code / feishu / fairy / scheduler
              ↓
           workflow
          ↙    ↘
        core    tools
       ↙  ↘      ↓
     llm  shared ← types
      ↓
   ai-sdk
```

| 包 | 职责 |
|---|---|
| `@n0n/types` | 零依赖的领域类型：`DomainMessage` 判别联合、`Renderer` 接口、工具调用类型 |
| `@n0n/llm` | LLM 客户端封装：`chatCompletion` / `chatCompletionStream`（SSE）、`StreamAccumulator`、消息适配器、Prompt Caching |
| `@n0n/tools` | 工具注册表：`exec`（命令执行）、`write`（文件创建）、`edit`（意图驱动编辑）、`reminder`（OKR 备忘）、`submit`（结果提交）；参数通过 Zod schema 运行时校验 |
| `@n0n/core` | 核心引擎：`agentLoop`（底层循环）、运行时上下文、安全配置 |
| `@n0n/shared` | 跨包工具：Skills 发现、Frontmatter 解析、对话持久化、Bootstrap |
| `@n0n/workflow` | 业务流水线：`delegateTask`（完整流水线：咨询→RAG→执行）、`generate`（轻量生成）、Workflow 运行时 |
| `@n0n/scheduler` | Cron 调度：MDC 文件驱动、定时任务管理 |

## 功能

### 工作流引擎

- **自然语言创建** — 用户描述任务，AI 自动生成 TypeScript 工作流
- **Skills 注册与组合** — 基于 `SKILL.md` 规范，支持渐进式上下文加载
- **Subagent 委托** — 多 Agent 协作，任务可委托给子 Agent 执行
- **RAG 增强** — 自动检索记忆、技能、历史记录，增强任务上下文

### 交互入口

| 入口 | 说明 |
|-----|------|
| CLI REPL | 交互式终端，workflow builder 模式 |
| Code Agent | 代码编辑专用，产出任意项目的代码变更 |
| 飞书 Bot | WebSocket 长连接，流式卡片渲染 |
| Scheduler | Cron 驱动，定时执行已注册的工作流 |

### 核心工具集

| 工具 | 功能 |
|-----|------|
| `exec` | 脚本执行（支持 cmd/pwsh/bun/node/uv 多运行时） |
| `write` | 文件创建/覆盖 |
| `edit` | 意图驱动的文件编辑（影子编辑 + Editor Agent） |
| `reminder` | 延迟提醒（OKR 跟踪、阶段规划） |
| `submit` | 结果提交（动态 schema 校验） |

## 特性

### 技术特性

- **多 Provider 支持** — OpenAI / Anthropic / Google / OpenAI 兼容 API
- **Extended Thinking** — 支持 DeepSeek 等推理模型的思考过程流式输出
- **Prompt Caching** — 智能缓存断点选择，降低 API 成本
- **流式渲染** — 终端 TUI 实时渲染，支持思考过程、工具调用、状态更新
- **对话持久化** — 自动保存/恢复对话历史，支持 `--resume` 恢复
- **运行时校验** — 工具参数通过 Zod schema 校验，类型安全

### Skills 系统

基于 [Agent Skills 规范](https://agentskills.io/)，支持：

```
my-skill/
├── SKILL.md          # 必需：元数据 + 指令
├── scripts/          # 可选：可执行脚本
├── references/       # 可选：参考文档
└── assets/           # 可选：模板、资源
```

- **渐进式披露** — 启动时仅加载 name/description，激活时加载完整指令
- **自动发现** — 扫描 `workflows/skills/` 目录自动注册
- **自由组合** — TypeScript `import`/`export` 即可组合

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

# 交互式对话（Workflow Builder）
bun start

# 代码编辑 Agent
bun start:code

# 直接传入任务
bun start "帮我每天早上总结 Hacker News 热门"
```

## CLI 命令

```bash
# 交互式 REPL（默认）
bun start

# 恢复上次对话
bun start --resume

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
| `LLM_ENABLE_THINKING` | | `false` | 设为 `true` 启用 Extended Thinking |
| `LLM_THINKING_BUDGET` | | `8192` | Thinking token 预算 |

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
| `HISTORY_DIR` | `workflows/history` | 历史记录目录 |

## 工作流程

```
用户："帮我分析这个 CSV 找出异常数据"
         ↓
   ┌─ Interactive REPL / 飞书 Bot ─┐
   │  解析用户意图，注入上下文      │
   └──────────┬───────────────────┘
              ↓
   ┌─ Consultation（可选）────────┐
   │  咨询最佳实践，生成建议文档    │
   └──────────┬───────────────────┘
              ↓
   ┌─ RAG Search ─────────────────┐
   │  检索记忆、技能、历史记录      │
   └──────────┬───────────────────┘
              ↓
   ┌─ Agent Loop ─────────────────┐
   │  LLM ↔ 工具调用循环           │
   │  exec · write · edit         │
   │  reminder · submit            │
   │  Zod schema 校验              │
   │  最多 4 次重试                │
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
- **LLM SDK** — [Vercel AI SDK](https://sdk.vercel.ai)
- **Schema 校验** — [Zod](https://zod.dev)
- **飞书 SDK** — [@larksuiteoapi/node-sdk](https://github.com/larksuite/node-sdk)
- **TUI** — React + Ink

## 开发

```bash
# 类型检查（全部包）
bun run typecheck

# Lint + 自动修复
bun run lint

# 单独启动某个 app
bun run apps/cli/src/index.ts
bun run apps/code/src/cli.ts
bun run apps/feishu/src/index.ts
bun run apps/scheduler/src/index.ts
```

## 文档

设计文档位于 `docs/` 目录：

- `draft.md` — 原始设计思路
- `skills/` — Skills 系统文档
- `tools/` — 工具设计文档
- `thinking-fix-conclusion.md` — Extended Thinking 修复方案
- `editor-loop渲染优化.md` — 编辑器循环渲染优化

## License

MIT
