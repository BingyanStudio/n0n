# n0n — 自然语言驱动的工作流引擎

> Code-first workflow engine: 用自然语言描述任务，AI 自动创建、测试、交付可复用的 TypeScript workflow。

## 核心理念

- **代码即工作流** — 不用拖拽式 DAG，直接用 TypeScript 编写 workflow
- **AI 创建 workflow** — 用户描述任务 → AI 编写 .ts 文件 → 运行验证 → 迭代修正 → 交付可复用 workflow
- **自扩展** — 每个 .ts 文件就是一个 skill，import/export 即组合
- **文件系统即注册表** — `workflows/skills/` 和 `workflows/tasks/` 即发现机制

## 快速开始

```bash
# 安装依赖
bun install

# 配置 .env
LLM_BASE_URL=https://api.example.com
LLM_API_KEY=sk-xxx
LLM_MODEL=deepseek/deepseek-v3.2

# (可选) 阻止特定命令执行，需人工审核后才能运行
# 以逗号分隔的命令名列表，例如：
BLOCKED_COMMANDS=rm,mv,dd

# 交互式对话 — AI 自动创建 workflow
bun start

# 飞书入口服务（官方长连接 WSClient，同时启动 scheduler）
bun run src/cli/index.ts feishu start

# 直接传入任务
bun start "帮我每天早上总结 Hacker News 热门"

# 运行已有 workflow
bun run src/main.ts run workflows/tasks/xxx.ts

# 定时任务
bun run src/main.ts schedule add hn-daily "0 8 * * *" "总结 HN 热门"
bun run src/main.ts scheduler start

# 查看所有 workflow
bun run src/main.ts workflows
```

飞书入口所需环境变量（长连接模式）：

```bash
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
# 可选
FEISHU_ENCRYPT_KEY=xxx
FEISHU_DOMAIN=feishu
```

## 工作流程

```
用户："帮我分析 CSV 找出异常"
         ▼
  workflow-builder agent
    1. 理解任务需求
    2. 编写 workflows/tasks/csv-analysis.ts
    3. 运行测试: bun run <workflow>
    4. 报错 → 修改代码 → 重新测试
    5. 通过 → submit workflow 路径
         ▼
  ✅ 可复用的 .ts workflow 文件
```

## Workflow 类型

### 直接代码（确定性任务）
```typescript
/** 获取天气信息 */
export default async function run() {
  const proc = Bun.spawn(["curl", "-s", "https://wttr.in/Tokyo?format=j1"], { stdout: "pipe" });
  const data = JSON.parse(await new Response(proc.stdout).text());
  return { city: "Tokyo", temp: data.current_condition[0].temp_C + "°C" };
}
```

### AI 驱动（需要推理的任务）
```typescript
import { subagent } from "../../src/index.ts";
/** 分析 CSV 异常数据 */
export default async function run() {
  const result = await subagent("分析 data/sample.csv 找出异常数据");
  return result.result;
}
```

## 架构

```
src/
  types/       DomainMessage 领域类型（判别联合，数据与提示词分离）
  llm/         LLM 客户端 + DomainMessage → API 消息适配器
  agent/       Agent Loop（exec/write/reminder/submit 工具）+ subagent
  task/        delegateTask 流水线（意图增强 + RAG + 执行）
  scheduler/   定时触发器（cron + 持久化调度表）
  workflow/    Workflow 运行时（文件系统发现 + 动态 import）
workflows/
  skills/      可复用的 skill（.ts 文件）
  tasks/       任务 workflow
  memory/      记忆存储
  history/     历史记录
```

## License

MIT
