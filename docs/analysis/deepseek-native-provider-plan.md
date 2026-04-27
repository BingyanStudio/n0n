# DeepSeek Native Provider 实施方案

> 日期：2026-03-05

---

## 一、为什么要做

### 1.1 价格

| 模型 | 输入 ($/MTok) | 输出 ($/MTok) | 缓存命中 ($/MTok) | 每轮 Agent Loop 成本 |
|---|---|---|---|---|
| Claude Opus | $5.000 | $25.000 | $0.5000 | $0.135 |
| DS-V4-Pro (2.5折) | $0.417 | $0.833 | $0.0035 | $0.004 |
| DS-V4-Flash | $0.139 | $0.278 | $0.0028 | $0.002 |

> 每轮按 50K 缓存命中 + 2K 新输入 + 4K 输出估算。

- Pro 缓存命中价格是 Opus 的 **1/144**
- 典型 agent loop 每轮成本：Pro 是 Opus 的 **1/31**，Flash 是 Opus 的 **1/88**
- 以上 Pro 价格还是 2.5 折促销价，即使恢复原价（4 倍），仍然是 Opus 的 1/8

### 1.2 原生特性

通过 OpenAI 兼容 API 访问 DeepSeek **无法使用**的特性：

| 特性 | 说明 | 价值 |
|---|---|---|
| DSML Tag | 模型训练时使用的原生标签格式 | 更精准的结构化理解 |
| Task Token | 意图路由（action/query/title 等） | 跳过思考直接执行、轻量分类 |
| `latest_reminder` 角色 | 不打断对话流的即时提醒 | 对 agent 的 reminder 机制特别有用 |
| `developer` 角色 | 一次性高优先级覆盖指令 | Roleplay 防御、动态工具注入 |
| 对话前缀续写 (Beta) | 控制 assistant 回复开头 | 引导输出格式 |
| 1M 上下文 + 384K 输出 | 超长上下文 | 大型项目全量代码分析 |

### 1.3 项目已有基础

- `packages/shared/src/tags.ts`：**已实现** deepseek DSML tag 风格（`<｜DSML｜name>`）
- `packages/llm/src/openai-client.ts`：已有 `reasoning_content` 解析
- `packages/shared/src/format-prompt/`：DomainMessage → PromptMessage 管线成熟
- `packages/types/src/client.ts`：`TagStyle` 已包含 `"deepseek"`

---

## 二、方案选择

| 方案 | 可行性 | 能拿到的特性 |
|---|---|---|
| **A: 独立 DeepSeekClient** | ✅ 推荐 | 全部（DSML + task token + 扩展角色） |
| B: 继续走 openai-compatible | ❌ | 无原生特性 |
| C: 走 DeepSeek 的 Anthropic 兼容端点 | ⚠️ 过渡可用 | thinking + caching，但无 task token 等 |

**选 A，分步实施。**

---

## 三、实施路线

### Phase 1: 基础连通（先跑起来）

目标：`LLM_PROVIDER=deepseek` 即可访问 DeepSeek API。

需要改动的文件：

| 文件 | 改动 |
|---|---|
| `packages/llm/src/config.ts` | 新增 `DeepSeekProviderConfig` 分支 |
| `packages/llm/src/deepseek-client.ts` | **新文件** — 实现 `LLMClient` 接口 |
| `packages/llm/src/factory.ts` | switch 新增 `case "deepseek"` |
| `packages/llm/src/config-from-env.ts` | `PROVIDER_TYPES` 新增 `"deepseek"`，env 映射 |
| `packages/types/src/client.ts` | `TagStyle` 确认已有 `"deepseek"` |

Phase 1 的 `DeepSeekClient` 走 OpenAI 兼容协议（`https://api.deepseek.com`），SSE 解析逻辑可从 `OpenAIClient` 提取为共享模块。与当前 `openai-compatible` 的区别：

- 独立的 provider 配置分支（DeepSeek 专属参数如 thinking 模式切换）
- `tagStyle` 强制为 `"deepseek"`
- 为后续 Phase 添加原生特性打下基础

预估：~300 行新代码。

### Phase 2: DSML 工具调用编码

目标：工具调用使用 DeepSeek 原生 DSML 格式，而非 OpenAI JSON 格式。

```
当前（OpenAI 格式）:
  tool_calls: [{ function: { name: "exec", arguments: '{"script":"ls"}' } }]

目标（DSML 格式）:
  <｜DSML｜tool_calls>
  <｜DSML｜invoke name="exec">
  <｜DSML｜parameter name="script" string="true">ls</｜DSML｜parameter>
  </｜DSML｜invoke>
  </｜DSML｜tool_calls>
```

需要改动的文件：

| 文件 | 改动 |
|---|---|
| `packages/llm/src/deepseek-client.ts` | 请求构建改用 DSML 编码；响应解析增加 DSML 解码 |
| `packages/shared/src/tags.ts` | 可能需要增加 DSML 工具调用专用的编解码函数 |

关键决策点：DeepSeek 的 OpenAI 兼容端点是否支持 DSML 格式的工具调用？如果不支持，Phase 2 可能需要走 DeepSeek 原生 API（非 OpenAI 兼容）。

### Phase 3: 扩展消息角色

目标：支持 `latest_reminder` 和 `developer` 消息角色。

需要改动的文件：

| 文件 | 改动 |
|---|---|
| `packages/types/src/domain.ts` | DomainMessage union 新增 `latest_reminder` 和 `developer_instruction` 类型 |
| `packages/shared/src/format-prompt/index.ts` | `formatPrompt` 新增对应 case |
| `packages/llm/src/deepseek-client.ts` | `PromptMessage` → DeepSeek API 消息时处理新角色 |
| `packages/core/src/agent/loop.ts` | `injectReminders()` 改用 `latest_reminder` 角色（当 provider 为 deepseek 时） |

与现有 reminder 机制的对接：

```
当前：reminder:due → formatReminderDue → role: "user"
目标：reminder:due → formatReminderDue → role: "latest_reminder"（DeepSeek 时）
```

### Phase 4: Task Token 意图路由

目标：agent loop 可以为不同类型的操作设置 task token，加速执行。

需要改动的文件：

| 文件 | 改动 |
|---|---|
| `packages/types/src/domain.ts` | DomainMessage 某些类型新增 `task` 可选字段 |
| `packages/llm/src/deepseek-client.ts` | 请求构建时根据 task 字段注入 task token |
| `packages/core/src/agent/loop.ts` | 某些场景自动设置 task（如明确需要工具调用时设 `action`） |

Task token 注入时机的判断逻辑（agent loop 层面）：

| 场景 | task 值 | 触发条件 |
|---|---|---|
| 工具执行后继续 | `action` | 上一轮有 tool_calls 且 tool_result 表明需要继续操作 |
| 标题生成 | `title` | 对话首轮后生成标题（非 agent loop，走 complete()） |
| 简单问答 | `query` | 意图分类器判定为简单问题 |

---

## 四、风险与注意事项

### 4.1 API 兼容性

DeepSeek 官方 API 同时提供 OpenAI 和 Anthropic 兼容端点，但原生特性（task token、DSML 编码）可能需要走非兼容的原生 API。需要确认：

- 原生 API 的请求/响应格式（是否有文档）
- task 字段的传递方式（在标准 API 层面，还是需要特殊的 encoding 层）

### 4.2 模型差异

V4-Flash 和 V4-Pro 在 task token 支持上可能有差异。需要测试两个模型对各 task token 的响应行为。

### 4.3 向后兼容

Phase 1 完全向后兼容——只是新增了一个 provider 选项。现有的 `openai-compatible` + DeepSeek 配置继续工作。Phase 2-4 的改动都封闭在 DeepSeek provider 内部，不影响其他 provider。

### 4.4 缓存策略

DeepSeek 的缓存命中价格极低（Pro ¥0.025/MTok），缓存优化的 ROI 非常高。现有的 `cacheBreakpoint` 机制需要适配 DeepSeek 的缓存协议。
