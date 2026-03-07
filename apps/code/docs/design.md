# Code Agent 设计文档

## 动机

n0n 当前的交互模式（`apps/cli`）定位为 workflow builder——产出物是 `.ts` workflow 文件。
Code 场景的产出物是**任意项目的代码变更**，需要不同的提示词、submit schema 和交互模式。

## 架构概览

```
packages/cli-ui/          ← 共享终端 UI（从 apps/cli 提取）
  ansi.ts                 (颜色、光标、label/style)
  live-region.ts          (行替换)
  rich-renderer.ts        (RichRenderer)

apps/cli/                 ← workflow agent，import from @n0n/cli-ui
apps/code/                ← code agent，import from @n0n/cli-ui
  src/
    index.ts              (入口)
    repl.ts               (REPL 循环)
    schema.ts             (CodeResultSchema)
    prompts/code.md       (system prompt)
  docs/
    design.md             (本文档)
```

核心引擎 `agentLoop()` 不变——code 场景只是不同的 prompt + schema + context。

## 用户交互机制：submit userResponse

当 agent 提交 `need_info` 类型的 submit 时，用户的回答**注入到 SubmitToolResult.userResponse 字段**，
而非作为独立的 user 消息。模型在同一个 tool result 上下文中看到答案：

```
assistant: submit({ type: "need_info", message: "目标分支？" })
tool_result: Submitted successfully. <user_response>main</user_response>
```

这样模型可以在同一轮 loop 内继续工作，无需重新启动。

## Submit Schema

```typescript
const CodeResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("completed"),
    summary: z.string(),
    files_changed: z.array(z.string()),
  }),
  z.object({
    type: z.literal("need_info"),
    message: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    error: z.string(),
    attempts: z.array(z.string()),
  }),
]);
```

## Context 注入

每轮注入项目上下文（XML 结构）：

```xml
<git_status>
M src/index.ts
?? src/new-file.ts
</git_status>
<git_branch>feat/my-feature</git_branch>
```

## System Prompt 设计

`code.md` 与 `interactive.md` 的核心差异：
- **Background**：code agent，不是 workflow builder
- **Tools**：强调 understand → implement → verify 循环
- **Constraints**：强调先读后改、改后验证
- **无 Specification 段**：不包含 n0n workflow 规范（通用编码场景）

## 实施状态

- [x] `packages/cli-ui` 提取
- [x] `apps/code` 骨架（index + repl + schema + prompt）
- [ ] 端到端测试
- [ ] 迭代优化 code.md 提示词
