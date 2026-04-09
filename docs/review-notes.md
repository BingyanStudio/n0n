# Code Review Notes — 架构观察与命题讨论

> 评论者：Mebius（无限の蛇）
> 范围：n0n 全项目代码评审
> 日期：2025-01

## 一、整体架构印象

这个项目的分层设计非常清晰：

```
types（纯类型，零依赖）
  ↑
shared（纯函数工具集）← llm（协议实现）
  ↑                      ↑
core（编排层：agentLoop） ← tools（工具注册表）
  ↑
apps（入口：code / fairy / feishu）
```

几个值得称赞的设计决策：

1. **DomainMessage 与 PromptMessage 的分离**——历史记录是纯领域数据，不含提示词措辞。换模型、改措辞不需要迁移历史。
2. **三层管道（parseStream → scheduler → renderBuffer）**——流式解析、并行执行、有序渲染三个关注点彻底解耦。
3. **影子编辑（Shadow Edit）**——主模型只表达意图，影子层负责精确操作，各自优化互不干扰。
4. **Anti-few-shot 变体**——确定性伪随机选择 + murmur3 hash，既打破模式又保证 cache 安全。
5. **自实现 LLM Client**——对 SSE 解析、thinking 链路、缓存注入的完全控制权。

---

## 二、命题 1：Cache TTL 5min 超时后的策略

### 问题
模型（Anthropic）的 prompt cache TTL 为 5 分钟。如果用户超过 5 分钟没有回复，缓存过期，下一次对话需要全量重算 input。

### 当前状态
- `anthropic-client.ts` 使用 `cache_control: { type: "ephemeral" }` 启用自动缓存
- `executor.ts` 的 `MAX_TIMEOUT_S = 240` 已经考虑了 cache TTL 约束
- `fairy/view.ts` 的跳变窗口设计最大化了前缀稳定性

### 可能的策略

#### 策略 A：心跳刷新（Heartbeat Refresh）
在接近 TTL 到期时（如 4 分钟），发送一个轻量级请求来刷新缓存前缀。

```
用户发送消息 → 正常处理 → 启动 4min 定时器
  ↓ (4min 后用户仍未回复)
发送心跳请求：只包含 system prompt + 最近几条消息
  → 目的不是获取有意义的回复，而是刷新 KV-cache
  → 可以用 max_tokens=1 最小化输出成本
  ↓
重置 4min 定时器，等待下一次超时
```

**优点**：对用户完全透明，下次回来时立即享受 cache hit  
**缺点**：每次心跳有 API 费用（写入 cache 的 token 仍然计费）  
**适用**：长对话（system prompt + 历史很长时），cache miss 的重算成本显著  

#### 策略 B：预测性缓存（Predictive Caching）
不是持续刷新，而是在用户可能即将返回时才刷新。

```
分析用户行为模式：
  - 如果用户通常在 8-10 分钟后回来 → 在 5 分钟时发送一次心跳
  - 如果用户通常在 30+ 分钟后回来 → 不浪费心跳，接受 cache miss
```

**适用**：fairy 模式（有长期行为数据），不适用于 code 模式（单次会话）

#### 策略 C：接受 cache miss，优化重建成本
不试图维持缓存，而是在 cache miss 发生时尽量降低重算成本。

```
- 保持 system prompt 短小精悍
- 压缩历史消息（fairy 的跳变窗口已经在做这件事）
- 在 cache miss 时使用更便宜的模型做首次请求（预热缓存），
  然后立即用正式模型重新请求（此时缓存已建立）
```

**我的建议**：策略 A 的实现最简单，可以先做一个可选的 `keepAlive` 机制，在 app 层面（而非 core 层面）控制是否启用。fairy 模式天然适合心跳刷新（持久化会话），code 模式则不需要（单轮任务）。

---

## 三、命题 2：Fairy 模式的定位

### 问题
Fairy 有很好的脑洞（状态驱动、跳变窗口、reminder 提取摘要），但缺乏明确的应用场景。角色扮演、工程委派、陪伴都做不到最好。

### 分析

Fairy 的核心能力是**持久化感知**——它记住你，它有自己的状态，它可以在你不在时自主行动。这三个能力中的每一个都不是 ChatGPT 或 Cursor 能做到的。

但目前的问题是：这些能力没有被聚焦到一个具体的用户需求上。

| 场景 | 用户核心需求 | fairy 的优势 | fairy 的劣势 |
|------|-------------|-------------|-------------|
| 角色扮演 | 表演质量、情感共鸣 | 记忆连续性 | 工具调用是噪音，人设模板太弱 |
| 工程委派 | 精确执行、代码质量 | 跨会话连续性 | code 模式更专业，角色设定是干扰 |
| 日常陪伴 | 被理解、被记住 | 记忆+自主行动 | 目前没有主动触发机制的实现 |

### 建议方向

**Fairy 应该做"有记忆的 AI 伙伴"，而不是"万能 agent"。**

具体来说：

1. **弱化工具调用**——只保留 memory edit、reminder 和轻量级 exec（查天气、查日历等）。不做重型工程任务，那是 code 模式的事。

2. **强化主动行为**——实现 scheduler 触发的自主行动：
   - 每天早上总结昨天的对话
   - 检测到用户项目有新 commit 时主动询问进展
   - 定期整理和清理记忆文件

3. **把记忆做成第一公民**——不只是"一个 md 文件"：
   - 结构化记忆（事实、偏好、关系、目标）
   - 自动遗忘过时信息
   - 记忆关联（"上次你提到 X 时也在做 Y"）

4. **多平台统一体验**——这是 fairy 状态驱动架构的天然优势：
   - CLI、飞书、Web 共享同一份状态
   - 在飞书上说的话，CLI 上也记得

5. **身份可定制**——让 identity.md 真正有用：
   - 提供预设人格模板（助理、朋友、导师、特定角色）
   - 人格不只是"说话风格"，还包括"什么时候主动说话""对什么话题感兴趣"

**一句话总结**：fairy 的竞争力不是"更好的对话"或"更好的代码"，而是"真正认识你的 AI"。

---

## 四、代码中散落的评论索引

所有 `// COMMENT:` 的位置：

### core（11 处）
- `loop.ts`: maxIter 语义、三层管道编排、截断恢复容错
- `streaming.ts`: JSON.parse 试探完整性、纯 async generator 可测试性
- `scheduler.ts`: 贪心队首调度、并行策略隐含假设
- `render-buffer.ts`: 并发有序输出（类比 HTTP/2）
- `tool-recovery.ts`: 占位 call 与 API 协议约束
- `runtime.ts`: 全局单例 vs 依赖注入、EditBackendConfig 类型精确性

### llm（8 处）
- `anthropic-client.ts`: eager_input_streaming、自动缓存+心跳刷新、手写 SSE 解析器
- `openai-client.ts`: litellm cache_control 透传、token 统计归一化
- `cache.ts`: prompt caching 演进记录
- `config.ts`: openai-compatible 逃生舱
- `index.ts`: 自实现 LLM Client 的权衡

### fairy（8 处）
- `design.md`: 定位分析与建议方向
- `index.ts`: fairyRound 状态转换、appendNewMessages 不变量
- `view.ts`: 跳变窗口缓存优化、reminder 摘要、消息排列顺序
- `state.ts`: identity 模板定位模糊
- `schema.ts`: FairyResponseSchema 扩展可能

### shared / tools / types（15 处）
- `format-prompt/index.ts`: DomainMessage→PromptMessage 桥梁、system 消息合并
- `seed.ts`: 确定性随机选择的 cache 安全性
- `tags.ts`: 模型特定 tag 风格推断
- `tokens.ts`: 二分法 token 截断
- `exec/executor.ts`: Promise.race 超时、MAX_TIMEOUT 与 cache TTL
- `tools/index.ts`: ToolEntry stream 设计、makeToolkit 异步原因
- `types/domain.ts`: ToolCallRecord 判别联合、DomainMessage 事件溯源

### apps/code（4 处）
- `index.ts`: 配置前缀切换
- `repl.ts`: gatherContext 瞬时状态
- `fewshot.ts`: fewshot 与 anti-few-shot 互补
- `headless.ts`: 可测试性与 ask_user 自动回复

### 其他（4 处）
- `edit/edit.ts`: 影子编辑双层架构、diff+feedback 双向通信
- `env.ts`: runtime 探测按用途分组
- `bootstrap/runner.ts`: LLMConnectionTester 依赖反转
