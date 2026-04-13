# 技术报告：LLM 配置系统重构方案（v3）

## 1. 确认的设计决策

- `ProviderConfigBase` **不含** `maxOutputTokens`——它从未有环境变量入口，三个 Client 读到的永远是 `undefined`，走各自硬编码的默认值。删掉这个字段，各 Client 继续用自己的常量即可。
- 行为字段下沉到各 `ProviderConfig` 分支。
- 配置渲染（`configTable`）应该根据 provider 动态显示相关变量。

## 2. 类型设计

```typescript
// config.ts

interface ProviderConfigBase {
  apiKey: string;
  model: string;
  baseUrl?: string;
  tagStyle?: TagStyle;
}

interface AnthropicProviderConfig extends ProviderConfigBase {
  provider: "anthropic";
  thinking?: { budgetTokens: number };
}

interface GoogleProviderConfig extends ProviderConfigBase {
  provider: "google";
  thinkingEffort?: "low" | "medium" | "high";
}

interface OpenAIProviderConfig extends ProviderConfigBase {
  provider: "openai";
}

interface OpenAICompatibleProviderConfig extends ProviderConfigBase {
  provider: "openai-compatible";
  baseUrl: string;
  backendProvider?: "anthropic" | "google" | "openai";
  enableThinking?: boolean;
}

type ProviderConfig = 
  | AnthropicProviderConfig 
  | GoogleProviderConfig 
  | OpenAIProviderConfig 
  | OpenAICompatibleProviderConfig;

// LLMConfig 只包装 providerConfig
interface LLMConfig {
  providerConfig: ProviderConfig;
}
```

## 3. Provider 驱动的 EnvSpec

核心变化：**LLM 配置组不再是一个静态的 `LLM_ENV_GROUP`，而是由 provider 类型决定显示哪些变量**。

```typescript
// common-specs.ts

// 基础变量（所有 provider 都需要）
const LLM_BASE_VARS: EnvVarDef[] = [
  { key: "LLM_PROVIDER", desc: "LLM provider 类型", default: "openai" },
  { key: "LLM_BASE_URL", desc: "LLM API 地址", default: "" },
  { key: "LLM_API_KEY", desc: "LLM API 密钥", secret: true },
  { key: "LLM_MODEL", desc: "模型名称" },
];

// Provider-specific 变量
const ANTHROPIC_VARS: EnvVarDef[] = [
  { key: "LLM_THINKING_BUDGET_TOKENS", desc: "思考 token 预算（设置即启用思考）", default: "" },
];

const GOOGLE_VARS: EnvVarDef[] = [
  { key: "LLM_THINKING_EFFORT", desc: "思考强度", default: "high" },
];

const OPENAI_COMPATIBLE_VARS: EnvVarDef[] = [
  { key: "LLM_BACKEND_PROVIDER", desc: "代理后端 provider", default: "" },
  { key: "LLM_ENABLE_THINKING", desc: "启用思考模式", default: "false" },
];

// 根据当前 provider 构建 EnvGroup
function buildLLMEnvGroup(provider: string): EnvGroup {
  const vars = [...LLM_BASE_VARS];
  switch (provider) {
    case "anthropic": vars.push(...ANTHROPIC_VARS); break;
    case "google": vars.push(...GOOGLE_VARS); break;
    case "openai-compatible": vars.push(...OPENAI_COMPATIBLE_VARS); break;
  }
  return { title: "LLM 配置", vars };
}
```

这样 `configTable` 渲染出来的就只有当前 provider 关心的变量——Gemini 用户看不到 `LLM_ENABLE_THINKING`，Anthropic 用户看不到 `LLM_THINKING_EFFORT`。

**但有个鸡生蛋的问题**：bootstrap 需要先知道 provider 才能决定显示哪些变量，但 provider 本身也是环境变量。解法很简单——`LLM_PROVIDER` 是基础变量，bootstrap 加载 .env 后就能读到，然后根据它动态构建后续的 env group。

## 4. 迁移步骤

1. `config.ts` — 类型重构（ProviderConfigBase + 各分支），删除 LLMConfig 上的行为字段和 maxOutputTokens
2. `config-from-env.ts` — 按 provider 分支组装行为字段
3. 三个 Client — 从 providerConfig 读取行为字段，删除 Gemini console.warn hack，各 Client 用自己的 max_tokens 默认值
4. `common-specs.ts` — 静态 LLM_ENV_GROUP 改为 buildLLMEnvGroup(provider) 动态构建
5. apps env-spec — 适配动态 env group
6. 测试更新
