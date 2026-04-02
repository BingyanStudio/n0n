# apps/code 环境变量审计 & 初始化引导 UX 检查报告

## 一、环境变量审计

### 1.1 apps/code/src/env-spec.ts 声明的变量组

| 组 | 来源 | 变量数 | 状态 |
|---|---|---|---|
| LLM 配置 | `LLM_ENV_GROUP`（shared） | 7 | ✅ 均有实际使用 |
| Editor LLM 配置 | `EDITOR_LLM_ENV_GROUP`（shared） | 7 | ✅ 均有实际使用 |
| 安全配置 | code 专属 | 1 (`BLOCKED_COMMANDS`) | ✅ 有使用，见下 |

### 1.2 各变量使用追踪

#### LLM 配置组（7 变量）

- `LLM_PROVIDER` — `packages/llm/src/config-from-env.ts` 中 `resolveProvider()` 读取
- `LLM_BACKEND_PROVIDER` — `config-from-env.ts` 中 openai-compatible 分支使用
- `LLM_BASE_URL` — `config-from-env.ts` 中 `buildProviderConfigFromEnv()` 读取
- `LLM_API_KEY` — 同上，所有 provider 必须
- `LLM_MODEL` — 同上 + `runner.ts` 连通性测试成功时显示
- `LLM_ENABLE_THINKING` — `config-from-env.ts` 中 `buildLLMConfigFromEnv()` 读取
- `LLM_THINKING_BUDGET_TOKENS` — 同上

**结论：无多余变量。**

#### Editor LLM 配置组（7 变量）

所有 `EDITOR_LLM_*` 变量均声明了 `inheritFrom` 指向对应的 `LLM_*` 变量。
`apps/code/src/index.ts` 中调用 `buildLLMConfigFromEnv("EDITOR_LLM", llmConfig.providerConfig)` 使用。

**结论：无多余变量。继承机制设计合理，不需要用户重复填写。**

#### 安全配置组

- `BLOCKED_COMMANDS`（default: `""`）
  - `packages/core/src/runtime.ts:50` — `parseBlockedCommands()` 解析
  - `packages/tools/src/exec/security.ts:63,90` — 执行命令安全检查时使用

**结论：有实际使用，非多余。由于有 `default: ""`，bootstrap 不会要求用户输入，行为正确。**

### 1.3 未在 env-spec 中声明但存在的环境变量

- `N0N_CODE_WORKSPACE` — 在 `cli.ts` help text 中提及，由 `parseWorkspaceArg()` 读取。
  这是 **CLI 运行时环境变量**，不属于 bootstrap 配置向导范畴，不需要加入 `env-spec`。设计合理。

### 1.4 审计结论

**apps/code 的 env-spec 无多余环境变量需求。** 所有声明的变量均有实际使用路径。

---

## 二、初始化引导程序 UX 检查

### 2.1 发现的问题：secret 输入无视觉反馈

**文件：** `packages/cli-ui/src/setup-renderer.ts` → `secret()` 方法

**问题描述：**
用户输入 API Key 等敏感信息时，由于 raw mode 下不回显，终端上完全无任何视觉反馈。
用户输入一长串密钥后屏幕上光标纹丝不动，容易误以为程序无响应或输入未被接收。

**修复方案：**
- 每输入一个字符，输出一个 `*` 到 stderr
- 退格删除时，用 `\b \b` 序列擦除对应的 `*`

**修复前行为：**
```
请输入 LLM_API_KEY (LLM API 密钥, 例如: sk-xxx): |          ← 光标不动
```

**修复后行为：**
```
请输入 LLM_API_KEY (LLM API 密钥, 例如: sk-xxx): *************|
```

**已修复** ✅ — 见本分支 commit。

### 2.2 其他 UX 检查项（均正常）

| 检查项 | 状态 | 说明 |
|---|---|---|
| .env 缺失时的创建引导 | ✅ | 提示 "是否创建 .env 配置文件？"，交互式向导 |
| 必填变量缺失提示 | ✅ | 明确列出缺少的变量名，逐个引导填写 |
| LLM 连通性测试 | ✅ | 测试成功显示模型名，失败提供"编辑/跳过"选择 |
| 配置摘要展示 | ✅ | 分组表格 + 来源标注 + 覆盖警告 |
| Editor LLM 继承确认 | ✅ | 自动检测可继承值，提示用户确认是否复用 |
| Ctrl+C 中断 | ✅ | secret 输入中 Ctrl+C 正确退出 |
| 非 TTY 模式降级 | ✅ | 非终端环境下 fallback 到 readline question |

---

## 三、变更清单

| 文件 | 变更 | 说明 |
|---|---|---|
| `packages/cli-ui/src/setup-renderer.ts` | 修改 `secret()` | 输入字符时输出 `*`，退格时擦除 |
| `reports/env-audit-and-bootstrap-ux.md` | 新增 | 本审计报告 |
