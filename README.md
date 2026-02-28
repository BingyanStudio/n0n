# n0n — 自然语言驱动的工作流引擎

> Code-first workflow engine: TypeScript 代码即 workflow，AI 自动编排与执行。

## 核心理念

- **代码即工作流** — 不用拖拽式 DAG，直接用 TypeScript 编写 workflow
- **AI 原生** — subagent 作为核心原语，模型在代码中自主调用工具完成任务
- **自扩展** — 写一个 .ts 文件就是注册一个 skill，import/export 即组合
- **文件系统即注册表** — `workflows/skills/` 和 `workflows/tasks/` 即发现机制

## 快速开始

```bash
# 安装依赖
bun install

# 配置 .env
LLM_BASE_URL=https://api.openai.com
LLM_API_KEY=sk-xxx
LLM_MODEL=gpt-4o

# 直接对话
bun run src/main.ts chat "帮我写一个 hello world"

# 完整任务流水线（咨询 + RAG + 执行）
bun run src/main.ts task "分析这个 CSV 找出异常"

# 运行 workflow 文件
bun run src/main.ts run workflows/tasks/csv-analysis.ts

# 定时任务
bun run src/main.ts schedule add hn-daily "0 8 * * *" "总结 HN 热门并发邮件"
bun run src/main.ts scheduler start
```

## 架构

```
用户（自然语言）
       ▼
┌─ Engine ──────────────────────────────┐
│                                       │
│  delegateTask 流水线：                 │
│    1. subagent 咨询（意图增强）        │
│    2. RAG 检索（memory/skill/history）│
│    3. 上下文组装 → subagent 执行      │
│                                       │
│  Agent 工具：exec / write / reminder / submit │
│                                       │
│  workflows/skills/  ← 文件系统即注册表 │
│  workflows/tasks/   ← ls + README 即发现│
└───────────────────────────────────────┘
```

## 目录结构

```
src/
  types/       DomainMessage 领域类型
  llm/         LLM 客户端 + 消息适配器
  agent/       Agent Loop + subagent
  task/        delegateTask 流水线 + RAG
  scheduler/   定时触发器
  workflow/    Workflow 运行时
workflows/
  skills/      可复用的 skill（.ts 文件）
  tasks/       任务 workflow
  memory/      记忆存储
  history/     历史记录
```

## License

MIT
