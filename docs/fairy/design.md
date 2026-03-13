## fairy 是什么

- 仍然是 agent
- 但是 一半角色扮演 一半工具使用
- 拥有记忆功能、可以记住之前的对话内容和用户的偏好
- 拥有设定、身份，可以根据设定和身份进行角色扮演
- 拥有全局的skill，可以在任何时候调用
- 拥有环境感知，可以感知当前的环境和上下文信息
- 拥有自己独立的目标和状态，可以脱离用户的指令自主行动

## 核心设计

因为本质上仍然是 agent 模式，所以我们需要在 agent 的基础上进行设计和实现

### 1. 独立状态、而不依赖对话和指令

依赖对话和指令会有一个问题，那就是我们换一个窗口，模型就直接忘了之前的对话内容了

我们的上下文组织不应该依赖于对话，而是维护一个单独的状态和数据库：
- 每次每次对话都是从状态开始
- 每次回复都是重新更新状态

从而我们能够做到：
1. 无论在哪个窗口，都能保持对话的连续性和一致性
2. 我们始终能够推送最新的环境和状态信息给模型，让它做出更合理的决策
3. 我们能够让模型在没有用户指令的情况下自主行动（因为本身就没有依赖用户指令了）

状态应该是 SSOT （Single Source of Truth），我们所有的设计和实现都应该围绕着状态来进行，而不是对话和指令。

状态应该是一个非常大的**数据**

我们需要创建一个 view 来从数据组织为上下文，这个上下文需要符合：
1. 前缀尽可能稳定，动态变化点在尾部
2. 通过一种神秘的组织方式（提取 reminder 调用），通过reminder还原完整的对话路径，从而实现天生的总结功能。

### 2. 状态机模型：state + input → output + new-state

fairy 的每一次执行本质上是一个**纯函数式状态转换**：

```
fairyRound(state, stimulus) → { response, newState }
```

- **state**：全局对话记录（JSON）+ markdown 文件（身份/记忆/偏好）
- **stimulus**：任何外部输入——用户消息、定时触发、环境变化
- **response**：角色回复（唯一的 submit schema 类型）
- **newState**：追加对话记录，模型可通过 edit 工具直接维护 md 文件

每次 submit 后更新状态。agentLoop 的 submit schema 只有一种类型：**作为角色的回复**。

### 3. 刺激源等价：anything input

所有输入对 fairy 来说都是等价的**刺激源**：

| 刺激类型 | 来源 | 包装方式 |
|---------|------|---------|
| 用户消息 | CLI / Feishu / API | `user_input` 类型 |
| 定时心跳 | scheduler | 类似 `reminder:due` 的注入 |
| 环境变化 | 文件系统监听、API 回调 | 系统消息注入 |
| 自主触发 | 上一轮 reminder 中的未完成目标 | 状态驱动的自动触发 |

关键设计：**新的触发会打断旧的触发**。因为每次都从状态重建上下文，所以这是自然的——不存在"恢复中断的对话"的问题，只有"从最新状态开始新一轮"。

### 4. View 层：从状态组装上下文

这是 fairy 最核心的创新点。传统 agent 的上下文是 `DomainMessage[]` 对话历史的线性堆叠。fairy 的上下文是从状态**重建**的。

#### 对话路径摘要（reminder + user_input 提取）

一段正常的对话历史：
```
[user_input] "帮我写个爬虫"
[assistant_tool_call] reminder({ content: "O: 写爬虫\nKR: [x] 分析需求 [ ] 实现" })
[tool_result] reminder acknowledged
[assistant_tool_call] exec({ script: "..." })
[tool_result] stdout: ...
[assistant_tool_call] write({ path: "crawler.ts", ... })
[tool_result] written
[assistant_tool_call] reminder({ content: "O: 写爬虫\nKR: [x] 分析需求 [x] 实现 [ ] 测试" })
[tool_result] reminder acknowledged
[assistant_tool_call] exec({ script: "bun test" })
[tool_result] stdout: all passed
[user_input] "加个代理支持"
[assistant_tool_call] reminder({ content: "O: 加代理\nKR: [ ] 修改请求层" })
...
```

从中**只提取 reminder 调用和 user_input**，就得到一个天然的摘要：
```
[user] "帮我写个爬虫"
[reminder] O: 写爬虫 / KR: [x] 分析需求 [ ] 实现
[reminder] O: 写爬虫 / KR: [x] 分析需求 [x] 实现 [ ] 测试
[user] "加个代理支持"
[reminder] O: 加代理 / KR: [ ] 修改请求层
```

这就是**对话路径**——不需要额外的总结算法，reminder 本身就是 agent 对自己进度的结构化记录。

#### 上下文组装顺序

```
┌─────────────────────────────────────────┐
│ [system] 身份设定（identity.md）         │ ← 最稳定（几乎不变）
├─────────────────────────────────────────┤
│ [system] 对话路径摘要                    │ ← 较稳定（只追加，不修改）
│   (从全局对话记录中提取 reminder+user)    │
├─────────────────────────────────────────┤
│ [system] 记忆和偏好（memory.md）         │ ← 半动态（模型通过 edit 维护）
├─────────────────────────────────────────┤
│ [system] 环境感知（时间、平台）           │ ← 动态（每轮更新）
├─────────────────────────────────────────┤
│ [stimulus] 当前刺激                      │ ← 尾部（本轮输入）
└─────────────────────────────────────────┘
```

**前缀稳定性**保证了 KV-cache 的高命中率。

### 5. 存储结构

```
.runtime/fairy/
  history.json        # 全局对话记录（DomainMessage[]），唯一的 JSON 状态
  identity.md         # 角色设定（模型可 edit）
  memory.md           # 长期记忆和用户偏好（模型可 edit）
  skills/             # fairy 专属 skill
```

- `history.json` 是 SSOT，存储完整的 `DomainMessage[]`
- `identity.md` 和 `memory.md` 是模型可直接维护的 markdown 文件
- 不单独存储 goals——模型通过 reminder 自管理目标和进度
- 不需要数据库——JSON + md 文件提供最好的可视化和可调试性

### 6. 与现有架构的关系

fairy 复用 `agentLoop` 核心循环，但在外层包装：

```
                    ┌──────────────┐
                    │  fairy app   │
                    │              │
  stimulus ──────►  │  buildView() │ ──► DomainMessage[]
                    │              │         │
                    │              │    agentLoop()
                    │              │         │
                    │  appendHistory()│ ◄── AgentResult
                    │              │
                    └──────────────┘
```

- `buildView(history, stimulus)` → 从全局对话记录 + md 文件 + 刺激源组装 `DomainMessage[]`
- `agentLoop(messages, { schema: FairyResponseSchema })` → 执行
- `appendHistory(history, result)` → 将本轮对话追加到全局记录

### 7. MVP 文件结构（CLI only）

```
apps/fairy/
  src/
    index.ts          # CLI 入口 + REPL
    state.ts          # history.json 读写
    view.ts           # buildView: history + md + stimulus → DomainMessage[]
    schema.ts         # FairyResponseSchema（角色回复）
  prompts/
    identity.md       # 默认角色设定模板
```
