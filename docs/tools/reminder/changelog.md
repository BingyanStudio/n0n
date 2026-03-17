# Reminder 工具：承诺-反思机制改进报告

> 本文档记录了 reminder 工具的一次重要改进，解决了 `feedback.md` 中提出的两个核心失效模式。
> 适用于所有集成了 reminder 工具的 agent 项目参考。

## 1. 问题回顾

### 1.1 无负反馈闭环

模型总是倾向于高估自己的能力，承诺在少量轮数内完成任务，但实际上无法做到。由于系统没有对"承诺违背"施加任何形式的负反馈，模型无法从错误的时间评估中学习，导致后续的 delay 设置同样不准确。

### 1.2 反思流于形式

当 reminder 到期（即承诺违背）时，模型往往直接忽略反思，继续推进下一步。但承诺违背可能意味着多种不同的根因：

- 错误地理解了任务
- 陷入了错误的解决方案
- 遭遇了意外的困难
- 需要外部帮助
- 使用了低效的策略

每种情况需要不同的应对措施，简单跳过反思会导致问题持续累积。

## 2. 根因分析

| 层级 | 原有实现 | 问题 |
|------|----------|------|
| **数据层** | `PendingReminder` 只有 `content` + `roundsLeft` | 不记录原始承诺轮数，到期时丢失承诺上下文 |
| **数据层** | `ReminderDueMessage` 只有 `content` | adapter 无法生成有针对性的反思引导 |
| **提示词层** | 到期消息仅为 "you must set a new reminder" | 没有结构化反思引导，模型可以轻易跳过 |
| **工具定义层** | description 只说 "set a memo" | 没有建立 delay = 承诺 的心智模型 |
| **关联性** | `<reminder>` 标签与 reminder 工具无显式关联 | 模型不清楚两者的因果关系，增加困惑度 |

核心洞察：**问题不在于模型"不愿意"反思，而在于系统没有提供足够的结构和上下文来引导有效反思。**

## 3. 解决方案

### 3.1 设计原则

1. **关注点分离** — 数据层只存结构化字段，提示词组装全部在 adapter（转换层）完成
2. **显式关联** — 工具定义中明确说明 `<reminder>` 标签的注入机制，减少困惑度
3. **标签激活** — 使用 `<reflection>` 标签作为反思入口，利用标签的结构化特性激活模型的反思模式
4. **承诺上下文传递** — `originalDelay` 从设置到到期全链路传递，让反思有据可依

### 3.2 改动详情

#### 3.2.1 数据层：记录承诺上下文

**`PendingReminder`** 增加 `originalDelay` 字段：

```ts
export interface PendingReminder {
    content: string;
    roundsLeft: number;
    originalDelay: number;  // 原始承诺轮数
}
```

**`ReminderDueMessage`** 增加 `originalDelay` 字段：

```ts
export interface ReminderDueMessage {
    type: "reminder:due";
    content: string;
    originalDelay: number;  // 原始承诺轮数
}
```

关键点：数据层只增加结构化字段，不包含任何提示词文本。

#### 3.2.2 工具定义层：建立承诺心智模型

工具 description 的核心变更：

```
Set a memo/reminder for yourself (overwrites any previous — only one active at a time).
The content will appear as `<reminder>` tag in a future user message after the specified delay (rounds).

**delay is a commitment** — you are promising to complete the current phase within N rounds.
If the reminder fires (delay expires), it means your commitment was not met.
You MUST then output a `<reflection>` block analyzing why, before setting the next reminder.

Prefer conservative estimates — overdelivering early is better than breaking a commitment.
```

设计要点：
- 显式关联 reminder 工具 → `<reminder>` 标签
- 将 delay 定义为"承诺"而非"猜测"
- 预告 `<reflection>` 的使用场景
- 引导保守估计

#### 3.2.3 转换层：结构化反思引导

**reminder 工具返回值**（设置成功时）：

```
Reminder set. Commitment: N rounds. A <reminder> will be injected when it expires.
```

包含承诺轮数和触发预告，强化因果关联。

**reminder:due 到期消息**（adapter 组装）：

```
{原始 reminder 内容}

⏰ Your commitment of N rounds has expired.

You **must** output a `<reflection>` block before your next tool call,
analyzing why the commitment was not met and how to adjust.
Then set a new reminder with updated progress and a revised commitment.
```

设计要点：
- 数据字段（content, originalDelay）在 adapter 层组装为提示词
- 包含承诺上下文（N 轮）
- 要求 `<reflection>` 输出，但不提供完整的类别和处理建议
- 保持简洁，避免过度指导导致模型机械执行

#### 3.2.4 注入层：传递承诺上下文

`injectReminders` 函数将 `originalDelay` 从 `PendingReminder` 传递到 `ReminderDueMessage`。

## 4. 为什么这样设计

### 4.1 为什么用 `<reflection>` 标签而不是自然语言指令？

XML 标签对 LLM 有结构化激活效果。`<reflection>` 标签：
- 明确划分反思内容的边界，避免与正常推理混淆
- 与工具定义中的预告形成呼应，建立一致的行为模式
- 避免每次触发时重复完整的反思指导（指导已在工具定义中给出）

### 4.2 为什么不提供完整的反思类别和处理建议？

`feedback.md` 列出了 5 种根因和对应措施，但我们选择不在到期消息中包含这些：
- 过度指导会导致模型机械地"填表"，而非真正反思
- 工具定义中已经建立了承诺-反思的心智模型，到期时只需触发即可
- 保持提示词简洁，减少 token 消耗

### 4.3 为什么不加历史违约记录？

保持单 reminder 的简洁设计。历史记录会引入额外状态管理复杂度，且当前 LLM 的上下文窗口足以让模型自行回顾近期的承诺履行情况。

## 5. 迁移指南

如果你的项目也使用了类似的 reminder 机制，以下是迁移要点：

### 5.1 最小改动

1. `PendingReminder` 增加 `originalDelay` 字段
2. 到期消息类型增加 `originalDelay` 字段
3. 到期消息的提示词中包含承诺上下文和 `<reflection>` 要求

### 5.2 工具定义更新

在 reminder 工具的 description 中：
- 明确 delay 是承诺（commitment）
- 说明触发时会注入什么标签
- 说明触发后需要输出什么标签
- 引导保守估计

### 5.3 关注点分离

确保数据层（消息类型）只存储结构化字段，提示词的组装在转换层（adapter）完成。这样当你需要调整提示词策略时，只需修改 adapter，不影响数据流。

## 6. 后续观察方向

本次改进是提示词层面的优化，效果需要在实际使用中观察：

1. **承诺准确度** — 模型设置的 delay 是否更接近实际消耗轮数？
2. **反思质量** — `<reflection>` 输出是否包含有意义的归因分析？
3. **行为调整** — 反思后的策略调整是否有效？
4. **保守倾向** — 模型是否开始倾向于保守估计？

如果观察到模型仍然系统性地高估能力，可能需要考虑更强的机制，例如在 system prompt 中注入历史承诺履行统计。
