# DeepSeek-V4 Encoding — 消息编码/解码格式分析

> 分析对象：用户提供的 `deepseek_v4_encoding.py`（DeepSeek-V4 原生消息编码器 Python 实现）
> 日期：2026-03-05

---

## 一、这是什么？

一份 **DeepSeek-V4 原生消息编码/解码器**。它定义了 DeepSeek 模型使用的内部消息格式，相当于 OpenAI Chat Completion API 的「翻译层」——把标准 OpenAI 格式的消息转换为 DeepSeek 模型能直接消费的原生 token 序列，同时把模型输出解析回结构化数据。

核心工作流：

```
OpenAI 格式消息 → merge_tool_messages() → encode_messages() → 模型原生 prompt string
模型输出 string → parse_message_from_completion_text() → OpenAI 格式 assistant message
```

---

## 二、Tag 体系

### 2.1 思考标签 `<think>...</think>`

包裹推理内容。模型先输出 `<think>推理过程</think>`，再输出最终答案。

| 策略 | 说明 |
|---|---|
| `drop_thinking` | 丢弃早期轮次的 reasoning_content，只保留最后一轮用户消息之后的推理。省 token 同时保持上下文连贯 |
| `reasoning_effort` | 三档控制——`None` 不追加前缀；`high` 代码中有 slot 但模板未展开；`max` 在首条消息前追加长前缀强制模型穷尽推理 |
| 过渡 token 策略 | thinking 模式 + 最新轮 → 拼 `<｜Assistant｜><think>`；非 thinking 模式 → 拼 `<｜Assistant｜></think>`（跳过思考直接回答） |

**过渡逻辑细节**：用户消息末尾拼接的 token 取决于 thinking 模式和 drop 行为：

```
thinking 模式 + drop_thinking=false → <｜Assistant｜><think>
thinking 模式 + drop_thinking=true + index >= last_user_idx → <｜Assistant｜><think>
thinking 模式 + drop_thinking=true + index < last_user_idx → <｜Assistant｜></think>
非 thinking 模式 → <｜Assistant｜></think>
```

### 2.2 DSML 标签（DeepSeek Markup Language）

命名空间 `巨硬`（`dsml_token` 的实际值），用于工具调用的结构化表示。

**工具调用块**：

```xml
<巨硬tool_calls>
<巨硬invoke name="tool_name">
<巨硬parameter name="param1" string="true">string_value</巨硬parameter>
<巨硬parameter name="param2" string="false">{"key": "value"}</巨硬parameter>
</巨硬invoke>
</巨硬tool_calls>
```

**工具结果块**（嵌入 user 消息）：

```xml
<tool_result>content</tool_result>
```

| 特性 | 说明 |
|---|---|
| 类型化参数 | `string="true"` → 纯字符串（不加引号）；`string="false"` → JSON（数字/布尔/对象/数组保持原样）。减少 LLM 序列化开销 |
| 工具结果内嵌 | DeepSeek-V4 没有独立 tool role。`merge_tool_messages()` 把多个连续 tool 消息合并成一个 user 消息，用 `content_blocks` 数组表示 |
| 结果排序 | `sort_tool_results_by_call_order()` 确保 tool_result 块顺序与上一条 assistant 消息中 tool_calls 顺序一致 |

### 2.3 任务特殊 Token

内部分类任务标记。在用户消息末尾追加特殊 token，告诉模型该消息的意图类型。

| task 值 | token 值 | 用途 |
|---|---|---|
| `action` | ` action` | 动作执行 —— 追加 `<｜Assistant｜><think>` + token，引导模型直接进入执行模式 |
| `query` | `Dou` | 查询 |
| `authority` | `ction` | 权限检查 |
| `domain` | `orate` | 领域分类 |
| `title` | `title` | 标题生成 |
| `read_url` | `read` | URL 读取 |

**关键机制**：`action` 与非 `action` 的处理不同——

- **action**：`...内容 + <｜Assistant｜><think>（或 </think>）+  action` → 引导模型跳过思考直接执行
- **非 action**：`...内容 + 对应 task_sp_token` → 引导模型进入对应分类/处理模式

### 2.4 角色转换 Token

| Token | 含义 |
|---|---|
| `<｜User｜>` | 用户消息前缀 |
| `<｜Assistant｜>` | 助手消息前缀 |
| `荣` | latest_reminder 前缀（系统级提醒，优先级高于普通 system 消息） |

`developer` 角色被转换为带 `<｜User｜>` 前缀的 user 消息（与普通 user 的区分在于内部标记）。

---

## 三、思考模式与过渡规则

### 3.1 thinking 模式

| 模式 | 行为 |
|---|---|
| `chat` | 普通对话，不输出 `<think>` 块 |
| `thinking` | 思维模式，在 `<think>` 块中输出推理 |

### 3.2 drop_thinking 裁剪规则

`_drop_thinking_messages()` 的行为：

- `user`、`system`、`tool`、`latest_reminder` 角色 → 始终保留
- `last_user_idx` 及之后的消息 → 始终保留
- `assistant` 在 last_user_idx 之前 → 保留但移除 `reasoning_content`
- `developer` 在 last_user_idx 之前 → 直接丢弃

### 3.3 reasoning_effort 前缀

仅在 `index == 0` 且 `thinking_mode == "thinking"` 且 `reasoning_effort == "max"` 时生效，在 system 消息前追加：

> Reasoning Effort: Absolute maximum with no shortcuts permitted.
> You MUST be very thorough in your thinking and comprehensively decompose the problem to resolve the root cause, rigorously stress-testing your logic against all potential paths, edge cases, and adversarial scenarios.
> Explicitly write out your entire deliberation process, documenting every intermediate step, considered alternative, and rejected hypothesis to ensure absolutely no assumption is left unchecked.

---

## 四、与本项目的关联

### 4.1 已有能力

- SSE streaming 已支持 `reasoning_content` 字段（`src/llm/stream.ts`）
- tool call 使用标准 OpenAI JSON 格式
- prompt formatting 有 anti-few-shot 变体系统（`format-exec.ts` / `format-edit.ts`）

### 4.2 可借鉴的点

| 方向 | 说明 |
|---|---|
| DSML codec | 如果未来对接 DeepSeek-V4 原生 API，需要实现 DSML 格式的 tool call 编码/解码 |
| drop_thinking 优化 | 目前 `StreamAccumulator` 已收集 reasoning 但在 `toMessage()` 中丢弃——正好可配合此机制节省多轮对话的 token |
| task tokens 思路 | 「意图分类快捷方式」可应用于 prompt 设计——用特殊 token 标记不同类型的 agent 任务 |
| latest_reminder | 适合实现 agent 的定时提醒/打断功能 |

### 4.3 注意事项

- DeepSeek reasoner 模型在某些版本中不支持 function calling。请求中包含 `tools` 和 `tool_choice` 可能导致模型降级为非 reasoning 模式
- 如果 `LLM_BASE_URL` 指向第三方代理（OpenRouter、one-api 等），代理可能剥离或重命名 `reasoning_content` 字段
- `StreamAccumulator.toMessage()` 中 reasoning 内容被丢弃，如果未来需要持久化或回传需要修改
