# 设计文档：progress 工具

## 概述

用 **progress** 工具替代现有的 submit 和 reminder。

progress 是 agent 唯一的结构化输出工具。每次调用 progress 时，agentLoop 终止并返回结果。外部调用方（repl.ts / headless.ts）拿到结果后自行决定是否重新启动循环。

## 动机

1. submit 只能在"做完/卡住"时调用——执行期间用户看不到进展
2. reminder 几乎不被使用——定时提醒机制不匹配实际需求
3. 需要让 agent 能产出阶段性状态，同时保持 agentLoop 接口不变

## 当前代码结构

```
packages/tools/src/submit.ts
  - makeSubmitToolDefinition(schema?) → ToolDefinition
  - submitTool(call) → SubmitToolResult
  - 工具 parameters 为开放 object，完整 JSON Schema 写入 description

packages/tools/src/reminder.ts
  - REMINDER_TOOL_DEFINITION
  - reminderTool(call, reminders) → ReminderToolResult
  - PendingReminder { content, roundsLeft, originalEstimate }

packages/tools/src/index.ts
  - makeToolkit(schema, toolsConfig, model) → Toolkit
  - buildBaseRegistry 注册 exec/write/edit/reminder
  - submit 在 makeToolkit 中单独构建并注入

packages/core/src/agent/loop.ts
  - agentLoop<T>(history, options) → AgentResult<T>
  - AgentResult = { result: T | null, report, history, tools }
  - 内部通过 checkSubmit 对 submit 调用做 schema 后验证
  - 校验通过 → 返回 result
  - 校验失败 → submit:rejected 消息，模型重试
  - injectReminders 在每轮开始时处理到期 reminder

apps/code/src/schema.ts
  - CodeResultSchema: discriminatedUnion("type", [completed, ask_user, request_assist])
  - 传入 makeToolkit 作为 submit 的校验 schema

apps/code/src/repl.ts
  - 调用 agentLoop → 拿到 AgentResult
  - 检查 result.type 决定后续行为（展示结果 / 等用户回复 / 等）
```

## 设计

### 核心原则

agentLoop 的行为不变——"跑到模型调用 progress 为止，返回结果"。它总是停。"是否继续"完全由外部决定。

### 底层：makeProgressTool（packages/tools）

替代现有的 `makeSubmitToolDefinition`。

```typescript
// packages/tools/src/progress.ts

export interface ProgressStatusConfig {
  /** status 枚举值 */
  value: string;
  /** 该 status 的含义说明（写入工具顶层 description） */
  statusDesc: string;
  /** 该 status 下 content 的格式说明（写入工具顶层 description） */
  contentDesc: string;
}

/**
 * 根据配置列表生成 progress 工具定义。
 * 
 * 生成的工具：
 * - name: "progress"
 * - description: 包含所有 status 的含义和对应 content 格式（从配置拼接）
 * - parameters: { status: z.enum([...]), content: z.string() }
 *   其中 status/content 的 describe 只写极简格式说明
 *   详细的 status↔content 对应关系在工具顶层 description 中
 */
export function makeProgressTool(config: ProgressStatusConfig[]): ToolDefinition {
  // 拼接工具 description：逐条列出 status 含义和 content 格式
  const statusDocs = config
    .map(c => `- ${c.value}: ${c.statusDesc}\n  content: ${c.contentDesc}`)
    .join("\n");

  const description = [
    "Report your current progress. This is the ONLY way to deliver content to the user.",
    "They cannot see your reasoning, tool calls, or intermediate results.",
    "",
    "Status types:",
    statusDocs,
    "",
    "Validation is enforced — non-conforming calls will be rejected.",
  ].join("\n");

  // parameters schema（极简，详细说明在 description 中）
  const statusEnum = config.map(c => c.value);
  const schemaObj = {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: statusEnum,
        description: "Current status",
      },
      content: {
        type: "string",
        description: "Content for this status",
      },
    },
    required: ["status", "content"],
    additionalProperties: false,
  };

  return {
    name: "progress",
    description,
    parameters: schemaObj,
  };
}
```

同时提供一个 zod schema 用于 agentLoop 内部的后验证：

```typescript
export function makeProgressSchema(config: ProgressStatusConfig[]) {
  return z.object({
    status: z.enum(config.map(c => c.value) as [string, ...string[]]),
    content: z.string(),
  });
}
```

执行器（替代 submitTool）：

```typescript
export function progressTool(call: ProgressToolCall): ProgressToolResult {
  return {
    type: "tool_result",
    tool: "progress" as const,
    call,
    cleanedResult: call.args,
    userResponse: undefined,
  };
}
```

### 上层：apps/code 的配置

```typescript
// apps/code/src/progress-config.ts

import type { ProgressStatusConfig } from "@n0n/tools";

export const codeProgressConfig: ProgressStatusConfig[] = [
  {
    value: "completed",
    statusDesc: "任务完成，提交最终汇报。假定用户已失去上下文，务必完整自包含。",
    contentDesc: "完成汇报——详细说明已完成的工作、验证结果和关键决策。",
  },
  {
    value: "working",
    statusDesc: "仍在进行中，汇报阶段性进展后继续工作。",
    contentDesc: "简述已完成什么、正在做什么、接下来计划做什么。",
  },
  {
    value: "blocked",
    statusDesc: "需要用户输入才能继续。",
    contentDesc: "向用户提出具体问题并提供 2-4 个选项。使用 DSL 格式：每选项以 `## ` 开头，下行写说明。",
  },
];
```

### 上层：repl.ts 的外部循环

当前 repl.ts 调用 agentLoop 后检查 `result.type`。改为检查 `result.status`：

```typescript
// 伪代码，展示逻辑变化

while (true) {
  const agentResult = await agentLoop<ProgressResult>(history, { toolkit, schema, ... });
  history = agentResult.history;

  if (agentResult.result == null) {
    // agent 异常终止（max iterations / error）
    break;
  }

  const { status, content } = agentResult.result;

  if (status === "completed") {
    // 展示最终结果，结束
    displayReport(content);
    break;
  }

  if (status === "working") {
    // 展示阶段性进展，然后继续循环
    displayProgress(content);
    // 不等用户输入，直接重新调用 agentLoop
    continue;
  }

  if (status === "blocked") {
    // 展示问题，等待用户输入
    displayQuestion(content);
    const userReply = await promptUser();
    // 注入用户回复，继续循环
    history.push(makeUserInput(userReply));
    continue;
  }
}
```

### agentLoop 内部改动

极小：

1. `checkSubmit` 逻辑不变——只是现在校验的 schema 是 `{ status, content }` 而非 `CodeResultSchema`
2. `REGISTERED_TOOLS` 中 `"submit"` 改为 `"progress"`
3. `makeToolkit` 中构建 progress entry 替代 submit entry
4. 移除 `injectReminders` 调用和 `reminders` 数组
5. 移除 reminder 在 `buildBaseRegistry` 中的注册

### 移除 reminder

- 删除 `packages/tools/src/reminder.ts`
- 删除 `@n0n/types` 中 reminder 相关类型（ReminderArgs, ReminderToolCall, ReminderToolResult, reminder:due 消息类型）
- 删除 agentLoop 中的 `injectReminders` 函数和 `reminders` 参数传递
- 删除提示词中关于 reminder 的说明

reminder 的功能被 progress(working) 覆盖：模型汇报阶段性进展时，自然包含了"我在做什么、到哪了"的信息。而且 progress(working) 的内容对用户可见——比只有模型自己看到的 reminder 更有价值。

## 类型变化（@n0n/types）

新增：
- `ProgressToolCall` — `{ id, tool: "progress", args: { status: string, content: string } }`
- `ProgressToolResult` — `{ type: "tool_result", tool: "progress", call, cleanedResult, userResponse? }`

移除：
- `ReminderArgs`, `ReminderArgsSchema`
- `ReminderToolCall`, `ReminderToolResult`
- `reminder:due` 消息类型

submit 相关类型改名为 progress（`SubmitToolCall` → `ProgressToolCall` 等）。

## 改动清单

| # | 位置 | 改动 |
|---|------|------|
| 1 | `packages/tools/src/progress.ts` | 新建。makeProgressTool + makeProgressSchema + progressTool |
| 2 | `packages/tools/src/submit.ts` | 删除 |
| 3 | `packages/tools/src/reminder.ts` | 删除 |
| 4 | `packages/tools/src/index.ts` | 移除 reminder 注册，submit entry 改为 progress entry |
| 5 | `packages/core/src/agent/loop.ts` | 移除 injectReminders 和 reminders 数组；REGISTERED_TOOLS 改名 |
| 6 | `packages/core/src/agent/round.ts` | checkSubmit 中的工具名 "submit" → "progress" |
| 7 | `@n0n/types` | 新增 Progress 类型，移除 Reminder 类型，SubmitXxx 改名 ProgressXxx |
| 8 | `apps/code/src/progress-config.ts` | 新建。定义 codeProgressConfig |
| 9 | `apps/code/src/schema.ts` | 移除 CodeResultSchema（由 makeProgressSchema(config) 替代） |
| 10 | `apps/code/src/repl.ts` | 外部循环适配：根据 status 决定继续/停止/等用户 |
| 11 | `apps/code/src/headless.ts` | 适配 progress 接口 |
| 12 | `apps/code/src/prompts/code.md` | 更新工具使用说明：submit→progress，移除 reminder 说明 |
| 13 | renderer | 审查是否需要改动以展示 progress(working) 的中间状态 |
