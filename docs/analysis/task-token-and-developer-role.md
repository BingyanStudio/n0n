# Task Token 与 Developer Role 详解

> 基于 DeepSeek-V4 Encoding 模块的深入分析
> 日期：2026-03-05

---

## 一、Task Token：轻量级意图路由

### 1.1 是什么

Task Token 是 DeepSeek-V4 模型内部的一种「意图路由」机制。在用户消息末尾拼接一个特殊 token，模型看到后无需额外的 prompt 指令就能切换到对应的处理模式。本质是用 **token 级别的信号替代 system prompt 中的指令**——更省 token，响应更快，延迟更低。

### 1.2 六种 Task 及对应 Token

| task 值 | token 值 | 语义 | 适用场景 |
|---|---|---|---|
| `action` | ` action` | 动作执行 | 引导模型跳过思考直接输出工具调用 |
| `query` | `Dou` | 直接查询 | 不需要多步推理的简单问答 |
| `authority` | `ction` | 权限检查 | 判断操作是否被允许 |
| `domain` | `orate` | 领域分类 | 将输入归类到预定义领域 |
| `title` | `title` | 标题生成 | 为内容生成简洁标题 |
| `read_url` | `read` | URL 解析 | 读取并理解 URL 内容 |

> **注意**：`action` 的 token 值以空格开头（` action`），其他 token 没有前导空格。`authority` 的 token `ction` 恰好是 `action` 去掉首字母 `a`。

### 1.3 两种插入模式

#### 模式 A：非 action 任务（轻量分类/生成）

```
用户消息内容 + task_sp_token
```

例如 `"这篇文章讲了什么？" + "Dou"` → 模型进入查询模式，直接回答。

**特点**：处理过程就是简单的字符串拼接，不改变消息结构。模型看到 token 后自动切换到对应的轻量行为模式。

#### 模式 B：action 任务（引导工具调用）

```
用户消息内容 + <｜Assistant｜> + (</think> | <think>) +  action
```

例如 `"读取 /etc/config" + <｜Assistant｜></think> action` → 模型被「欺骗」，以为 assistant 已经开启了回复并结束了思考阶段，从而直接输出工具调用块。

**关键细节**：中间的 thinking token 根据 thinking 模式决定——

| thinking 模式 | 插入的 token |
|---|---|
| `chat`（非思考） | `</think>` |
| `thinking`（思考） | `<think>` |

- **`</think>`**（chat 模式）：伪造「思考已结束」，模型直接进入回答/执行阶段 → **跳过推理，立刻行动**
- **`<think>`**（thinking 模式）：伪造「开始思考」，但这发生在 action 任务上下文中 → 模型被引导进行有方向的思考后执行工具调用

### 1.4 完整处理流程

```
1. render_message() 渲染消息内容
2. 检查 index+1 位置的消息是否为 assistant 或 latest_reminder
   → 是，才处理 task（意味着 task 标记后必须紧跟模型回复）
   → 否，走普通过渡 token 逻辑
3. 校验 task 值 ∈ {action, query, authority, domain, title, read_url}
4. 分支：
   a) task ≠ "action" → 直接拼接 task_sp_token
   b) task ＝ "action" → 拼接 <｜Assistant｜> + thinking_token + " action"
```

### 1.5 Action Tag 的自然触发流程

**task 字段不是模型自己生成的**，而是由**调用方（上层应用/agent 框架）在构造消息时设置的元数据**。

触发链路：

```
上层系统（Web 前端 / Agent 引擎 / 意图分类器）
  → 根据用户操作类型或意图，设置 message["task"] = "action"
  → 消息传入 encode_messages()
  → render_message() 检测到 task="action"
  → 在消息末尾伪造 <｜Assistant｜></think> action
  → 模型收到后跳过思考，直接输出工具调用
```

**典型触发场景**：

| 场景 | 触发方式 |
|---|---|
| DeepSeek 网页端用户点击「执行」按钮 | 前端代码设置 `task: "action"`，消息直接进入执行模式 |
| Agent 框架判定「需要工具调用」 | Agent loop 在构造消息时打上 `task: "action"` 标记，加速工具执行 |
| 意图分类器识别为「操作性意图」 | 分类模型输出 action 标签 → 构造消息时附加 task 字段 |
| 多步工作流引擎 | 工作流定义中标记某步骤为 action 类型 → 自动设置 task token |

**为什么存在这个机制**：相比在 system prompt 里写入「你是一个...请用 JSON 回答...」，用 task token 的优点是——

- 省 token（一个 token vs 几百个 token 的指令）
- 延迟低（模型从第一个 token 就知道要做什么模式）
- 减少 prompt injection 风险（task token 不在用户可见文本中）
- 状态机式的确定性行为（不依赖 prompt 措辞）

### 1.6 对项目的启发

1. **分流轻量任务**：当前 agent loop 对所有输入一视同仁。可以借鉴 task token 思路，为简单任务（标题生成、摘要、权限判断）设计快速通道，不走完整 agent 推理流程

2. **action 加速**：对于确定性强的工具调用（如「读取文件 X」），可模仿 action token 的「跳过思考直接执行」机制来降低延迟

3. **token 级别的条件控制**：不需要在 system prompt 中写入冗长的分支指令，而是在消息序列中嵌入控制信号

---

## 二、Developer Role：高于 System 的开发者指令

### 2.1 来源与定位

Developer 是 OpenAI 在 2024 年底为 o1 系列模型引入的新消息角色。它的定位是**比 system 更高优先级的指令层**，面向的是 API 的开发者/集成方，而非最终用户。

DeepSeek-V4 原生支持了这个角色，但在内部做了适配：将 developer 消息转换为带 `<｜User｜>` 前缀的特殊 user 消息。

### 2.2 Developer vs System vs User

| 特性 | system | developer | user |
|---|---|---|---|
| 语义 | 全局行为指令 | 开发者覆盖指令（最高优先级） | 最终用户输入 |
| 携带 tools | ✅ 全局工具定义 | ✅ 可追加任务级工具 | ❌ |
| 携带 response_format | ❌ | ✅ 可指定输出格式 | ❌ |
| 优先级 | 低（可被 developer 覆盖） | 高（覆盖 system） | N/A |
| 跨轮次持久性 | ✅ 始终保留 | ❌ 可能在 drop_thinking 时被丢弃 | ✅ 始终保留 |
| DeepSeek-V4 编码为 | `system_msg_template` | `user_msg_template + <｜User｜>` | `user_msg_template + <｜User｜>` |

### 2.3 为什么要区分 system 和 developer

OpenAI 引入 developer role 的动机：

- **关注点分离**：system 是「给模型的角色设定」（如「你是一个有帮助的助手」），developer 是「给 API 调用方的技术指令」（如「请用 JSON 格式回答，包含以下字段」）
- **安全性**：某些指令不适合暴露在 system 消息中（因为 system 可能被用户通过 prompt injection 覆盖），developer 优先级更高，更难被覆盖
- **工具注入**：developer 可以动态注入任务特定的工具定义，这在多租户/多任务场景中很实用

### 2.4 DeepSeek-V4 的适配方式

DeepSeek-V4 没有独立的 developer role token。处理方式：

```
原始 developer msg: { role: "developer", content: "...", tools: [...], response_format: {...} }

↓ render_message() 编码

<User>...内容...
(如有 tools) 拼接 render_tools(tools)
(如有 response_format) 拼接 response_format_template
```

这意味着：

1. Developer 消息在模型看来是一种**携带额外元数据的用户消息**
2. 保留了 developer 携带 tools 和 response_format 的能力
3. 与普通 user 的区别仅在于内部标记（developer 可带 tools，user 不可）

### 2.5 生命周期：被视为一次性指令

在 `_drop_thinking_messages()` 中：

```
keep_roles = {"user", "system", "tool", "latest_reminder"}

developer ∉ keep_roles → 位于 last_user_idx 之前的 developer 被完全丢弃
```

对比：

- `system` 在 `keep_roles` 中 → **始终保留**
- `developer` 不在 `keep_roles` 中 → **可能被丢弃**

**设计意图**：developer 被视为「一次性覆盖指令」。例如：

```
system:       "你是客服助手"
developer#1:  "处理退款请求"  ← 仅本轮有效
user:         "我要退款"
assistant:    ...处理退款...
developer#2:  "处理换货请求"  ← 仅本轮有效，覆盖前一个 developer
user:         "我要换货"
```

这种设计确保了 developer 指令不会「泄漏」到后续无关轮次中。

### 2.6 对项目的潜在用途

| 场景 | 说明 |
|---|---|
| 动态工具注入 | 当前每个 agent loop 传递全量 tools。可用 developer 消息按任务注入子集 |
| 结构化输出控制 | 某些任务需要特定 JSON 格式的响应，可用 developer + response_format |
| 优先级覆盖 | 需要覆盖 system prompt 中的某些行为时（如临时切换人格/模式），用 developer 比修改 system 更干净 |
| 多租户场景 | 不同用户/会话有不同的 behavior 配置，用 developer 注入而不污染全局 system |

### 2.7 即时指令与 Roleplay 防御

Developer 消息的本质是一条**即时命令**，与 system 的关键区别在于生命周期——system 是持续设定，developer 是**用后即焚的指令**。在 roleplay 场景中，system 设定角色人格，developer 每轮注入最新防御指令，防止用户用破坏性输入（如 `ignore all previous instructions`）磨损角色设定。相比单次 system 的被动防御，developer 的每轮动态注入机制可以主动适应上下文——根据上一轮用户行为调整防御强度或指令内容。DeepSeek-V4 的 developer 一次性特性正好契合此场景：旧 developer 被丢弃不会累积冗余，新 developer 只影响当前轮。

---

## 三、Developer Role 在 Anthropic Claude 中的映射

### 3.1 Anthropic 消息角色体系

Anthropic 的 Messages API 支持的角色：

- `system` — 系统提示词（**顶层参数**，不在 messages 数组中）
- `user` — 用户消息
- `assistant` — 助手回复（可包含 text + tool_use content blocks）

**Anthropic 不存在 `developer` role。**

### 3.2 架构差异

```
OpenAI / DeepSeek:
  messages: [
    { role: "system",    content: "..." },   ← 在数组中
    { role: "developer", content: "..." },   ← 在数组中
    { role: "user",      content: "..." },
  ]

Anthropic:
  system: "你是客服助手",                     ← 顶层参数，仅一个
  messages: [
    { role: "user",      content: "..." },
  ]
```

这意味着 Anthropic 的设计哲学在以下几个维度上与 OpenAI/DeepSeek 存在根本性差异：

### 3.3 功能对等分析

| OpenAI/DeepSeek developer 功能 | Anthropic 等效方案 | 是否等价 |
|---|---|---|
| 动态工具注入 | ❌ 不支持。tools 在 API 请求层定义，不能在 messages 中间动态修改 | 否 |
| 带 response_format | ⚠️ 通过 system 或 user 消息中的文本描述模拟结构化输出 | 部分 |
| 优先级覆盖 system | ⚠️ 单次请求内不可切换 system。需要多次 API 调用，每次传入不同 system 参数 | 部分 |
| 一次性指令（自动过期） | ⚠️ 在 user 消息中插入指令，依赖模型自行理解边界 | 近似 |

### 3.4 如果要在 Anthropic 中实现类似 developer 的效果

1. **动态改变 system prompt** → 在新请求中传入新的 `system` 参数。代价：无法在单次对话中切换
2. **一次性指令** → 作为一个 user 消息插入，语言上明确标识「以下是一次性指令，仅对本轮回复生效」
3. **工具集变更** → 在新请求中传入不同的 `tools` 参数。Anthropic 不支持消息级别的工具集切换
4. **结构化输出** → 通过 system prompt 描述输出格式，或在 user 消息中给出 schema 要求

### 3.5 总结

Anthropic 的设计更「静态」——system prompt 和 tools 在请求级别固定，对话过程中不可动态调整。OpenAI/DeepSeek 的设计更「动态」——允许在 messages 流中插入 system 和 developer 消息，实现消息级别的指令覆盖和工具注入。

这种差异反映了两个阵营对「安全 vs 灵活」的不同权衡：Anthropic 偏向锁定顶层参数以防止 prompt injection；OpenAI 偏向开放消息级别的控制以支持复杂 agent 工作流。

---

## 四、Task Token 能否在 n0n 中使用？

### 4.1 结论：不能直接用，但概念可迁移

Task Token 是 DeepSeek-V4 模型在训练阶段内置的特殊 token——模型的 tokenizer 和权重都是围绕这些 token 训练的。通过标准 OpenAI 兼容 API 调用 DeepSeek 时，这些 token 不在 API schema 中，无法传递。

### 4.2 三条路径评估

| 路径 | 可行性 | 说明 |
|---|---|---|
| 直接使用 | ❌ | n0n 通过 `openai-compatible` 路径访问 DeepSeek，`task` 字段不在 OpenAI Chat Completion schema 中，会被代理丢弃或报错。即使透传，其他模型（Claude、Gemini）不认识这些 token |
| 新增 DeepSeek-V4 native provider | ⚠️ 可行但重 | 需要实现 `DeepSeekClient`（与 `AnthropicClient`、`OpenAIClient` 同级），完整处理 DSML 编码/解码。工作量大，但如果未来深入 DeepSeek 生态则有价值 |
| 概念迁移 | ✅ 可立即探索 | task token 的核心思想（用消息级信号控制模型行为模式）不依赖具体 token 实现，可以在 prompt 层模拟 |

### 4.3 概念迁移方案

task token 的本质是「在 prompt 中嵌入控制信号，让模型无需冗长指令就能切换行为模式」。在 n0n 现有架构中，可以在 `formatPrompt`（`packages/shared/src/format-prompt/index.ts`）层实现类似效果：

| DeepSeek task token | n0n 中的概念迁移 |
|---|---|
| `action`（跳过思考直接执行） | 在 user 消息末尾追加 "Output tool calls directly without deliberation" |
| `query`（简洁回答） | 在 system prompt 追加 "CONCISE: answer in one sentence" |
| `title`（标题生成） | 已有的轻量 `complete()` 调用（不走 agent loop） |

不过需要注意：这种 prompt 级模拟的效果不如原生 token 级控制——prompt 指令可能被模型忽略，而原生 token 是训练级别的硬编码行为。

---

## 五、DeepSeek-V4 扩展消息角色

除了标准的 `system`、`user`、`assistant`、`tool` 四种角色，DeepSeek-V4 额外定义了三种扩展角色：

### 5.1 完整角色清单

| 角色 | 来源 | 独立 token | 始终保留 | 影响 last_user_idx |
|---|---|---|---|---|
| `system` | 标准 | 无（直接嵌入） | ✅ | ❌ |
| `user` | 标准 | `<｜User｜>` | ✅ | ✅ |
| `assistant` | 标准 | `<｜Assistant｜>` | ✅ | ❌ |
| `tool` | 标准 | 无（合并到 user） | ✅ | ❌ |
| **`developer`** | **扩展** | 无（复用 `<｜User｜>`） | **❌ 可丢弃** | **✅** |
| **`latest_reminder`** | **扩展** | **`acci`** | **✅** | **❌** |
| **`direct_search_results`** | **扩展** | 未知 | **✅** | **❌** |

### 5.2 `latest_reminder` — 不打断对话流的即时提醒

**编码方式**：`acci` + 内容

**位置语义**：可以插入在 user 和 assistant 之间，不触发 `<｜Assistant｜>` 过渡 token。这是它与所有其他角色最大的区别——它是一种「last-minute injection」，在模型即将回复之前插入一条不改变对话结构的提醒。

**代码中的特殊待遇**：

- `_drop_thinking_messages()`：在 `keep_roles` 中 → 始终保留，不会被丢弃
- `find_last_user_index()`：不视为 user → 不影响 thinking token 插入位置
- 过渡 token 逻辑：`messages[index+1].role not in ["assistant", "latest_reminder"]` → latest_reminder 不打断 user→assistant 过渡链

**推测用途**：

- 定时提醒到期（"你之前设定的提醒已触发"）
- 实时信息注入（"当前时间是..."、"用户刚修改了文件..."）
- 上下文补充（"注意：用户之前提到过..."）
- Agent 框架的打断/重定向信号

**与 n0n 的 `reminder:due` 对比**：

n0n 目前把到期的 reminder 编码为普通 user 消息（`formatReminderDue` → `role: "user"`）。如果使用 DeepSeek-V4 原生格式，可以改用 `latest_reminder` 角色，使其不计入 `last_user_idx`、不打断对话流。这在多轮 agent loop 中可能带来更好的上下文连贯性。

### 5.3 `direct_search_results` — 联网搜索结果注入

仅在 `_drop_thinking_messages()` 的 `keep_roles` 中出现，`render_message()` 中没有处理分支。

**推测**：这是 DeepSeek 联网搜索功能的内部实现——

1. 用户提问需要实时信息
2. DeepSeek 后端执行搜索
3. 搜索结果以 `direct_search_results` 角色注入到消息流
4. 模型看到搜索结果后生成回答

始终保留的原因：搜索结果是事实性信息，丢弃会导致回答失真。

### 5.4 三层指令体系

将所有角色按优先级和生命周期排列，可以看到 DeepSeek-V4 设计了一套三层指令体系：

```
位置：对话开头 ←————————————————————→ 紧贴模型回复
     system        developer        latest_reminder
     ↓              ↓                ↓
     持续设定        一次性覆盖指令      即时提醒
     始终保留        可被丢弃           始终保留
     无独立 token    复用 User token    有独立 token
```

这种分层设计的意义：不同层级的指令在「持久性」和「紧迫性」上做了不同的取舍——

- **system**：持久但可能被稀释（距离模型回复最远，中间隔着整个对话历史）
- **developer**：一次性但高优先级（紧贴最新用户消息，但可在压缩时丢弃）
- **latest_reminder**：既持久又紧迫（紧贴模型回复位置，且始终保留）
