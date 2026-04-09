# TODO — 缓存生命周期管理

> 成本分析：
> - [心跳刷新甜蜜点](./opus-4.6-heartbeat-analysis.md) · [可视化](./opus-4.6-heartbeat-chart.html)
> - [压缩策略对比](./compression-strategy-analysis.md) · [可视化](./compression-strategy-chart.html)
> - [压缩触发时机](./compression-trigger-analysis.md) · [可视化](./compression-trigger-chart.html)

---

## 1. Heartbeat — 缓存保活

在 prompt cache TTL（5min）到期前发送轻量请求（`max_tokens=1`）刷新缓存前缀。

### 接口设计

**核心矛盾**：心跳必须走与 `stream()` 相同的 `formatPrompt` + `cache_control` 路径才能命中缓存，但这些都是 client 内部行为。外部拿着 `DomainMessage[]` 无法自行构造缓存命中请求。

**排除的方案**：

- `StreamRequest` 加 `maxTokens`：调用方依赖 `stream()` 刷新缓存的副作用，这是实现细节不是接口语义
- 伴生函数 `createHeartbeatFn(config)`：把 provider 细节泄露到 apps 层，调用方需要额外知道"用 Anthropic 时还要调这个函数"
- client 内部自治（`startHeartbeat/stopHeartbeat`）：client 变成有状态的，与无状态设计冲突

**采用方案：`LLMClient` 加 optional `heartbeat?()` 方法**

```typescript
interface LLMClient {
  stream(request: StreamRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent>;
  complete(request: CompleteRequest): Promise<CompleteResponse>;
  readonly modelId: string;

  heartbeat?(messages: DomainMessage[]): Promise<TokenUsage | null>;
}
```

理由：
- 缓存保活是 client 的自然延伸——它知道自己的缓存机制，内部共享 `formatPrompt` + `toAnthropicMessages`，前缀一致性靠内聚保证
- Optional method：`AnthropicClient` 实现，`OpenAIClient` 不实现，不强制
- 调用方只认 `LLMClient`，通过 `client.heartbeat` 是否存在判断能力

### 控制层设计

`HeartbeatKeeper`（`packages/core/src/heartbeat/`）：

- 接受 `LLMClient`，检查 `heartbeat` 方法是否存在
- 管理定时器、计数上限（~20 次 ≈ 80min）、pause/resume
- 不依赖 `RuntimeContext` 全局单例，通过构造函数注入

Apps 在 REPL 循环中控制生命周期：

```typescript
const keeper = client.heartbeat
  ? new HeartbeatKeeper(client, { intervalMs: 240_000, maxCount: 20 })
  : null;

// agent 执行时暂停心跳，结束后恢复
agentRunning = true  → keeper?.pause()
agentRunning = false → keeper?.start(lastMessages)
```

fairy 模式启用（持久会话），code 模式不需要（`MAX_TIMEOUT_S = 240` 在 TTL 内）。

### 实现清单

- [ ] `packages/types/src/client.ts` — `LLMClient` 加 `heartbeat?`
- [ ] `packages/llm/src/anthropic-client.ts` — 实现 `heartbeat()`
- [ ] `packages/core/src/heartbeat/` — `HeartbeatKeeper` 类
- [ ] `apps/fairy/src/index.ts` — REPL 集成
- [ ] 可观测性：心跳日志 / token 统计

---

## 2. Compression — 上下文压缩

上下文增长到阈值时，调用模型对历史做摘要，降低后续缓存读取成本。

### 要点

- 两种后端：原模型压缩（利用 cache hit）/ 便宜模型压缩（全量输入但便宜）
- 最优触发间隔（r=0.15, 系统 30K, 步进 2.6K, 压缩到 5K, 隐性开销 $0.05~0.10）：约 12~15 步（上下文 66~74K）
- 需与 fairy `view.ts` 的跳变窗口机制协调

### 实现清单

- [ ] 通用压缩接口（输入 `DomainMessage[]`，输出摘要 `DomainMessage`）
- [ ] 压缩后端选择逻辑
- [ ] 触发策略（固定间隔 / 上下文大小阈值 / 成本预估）
- [ ] 压缩质量保障
