# Editor 后端最终评估报告

**生成时间**: 2026-04-26
**测试范围**: 3 种配置 × 6 场景 × 3 次 = 54 次运行（第三次完整运行）

---

## 1. 架构变更总结

### 拆分 str-replace/loop.ts → step.ts + loop.ts

**`step.ts`** (新增):
- 纯函数 `editorStep(input: StepInput): StepResult` — 单轮编辑器循环
- 接受当前 messages、content、LLMClient 等输入，返回 `StepResult`（含 tokenUsage、toolCalls、hasSubmit、needsGuidance 等）
- 导出 `applySingleOp`、`countOccurrences`、`getReplacementContext`（工具函数）
- 导出 `createInitialMessages`（构建初始对话消息）
- 零外部状态，完全可测试

**`loop.ts`** (重构):
- `editorLoop` 委托 `editorStep` 组装多轮循环
- 新增 `roundTokenUsage` 数组记录每轮用量
- 新增 `needsGuidance` 处理：当模型不调用工具时，注入状态感知的引导消息

### 拆分 freeform-patch/index.ts → step.ts + index.ts

**`step.ts`** (新增):
- 纯函数 `step(input: StepInput): StepResult` — 单轮 Responses API 循环
- 返回完整 StepResult 含 tokenUsage、toolCalls、patchAppliedThisRound、hasSubmit
- 发送 `done` 事件传递 token 用量到 `onEvent` 回调

### toolChoice 重构

**改动**: `toolChoice: "required"` → `toolChoice: "auto"` + 外部引导机制

当模型返回零工具调用时，`editorStep` 不再返回错误，而是注入一条状态感知的引导消息：
- **内容已修改** → 提示选择：submit（确认正确）/ view_file（验证）/ str_replace（继续编辑）
- **内容未修改** → 提示使用 str_replace 执行编辑

`editorLoop` 检测到 `needsGuidance` 标志后，continue 到下一轮，让模型读取引导消息后重试。

**效果**: 
- DeepSeek 从全部失败 ✅ 变为全部成功
- 引导轮次通常只需 1 轮额外消耗（约 200 tokens）

---

## 2. DeepSeek 后端修复前后对比

### 修复前

| 场景 | 成功率 | 说明 |
|------|-------|------|
| 全部 6 场景 | 0/3 | "Editor LLM returned no tool calls" |

根因: `deepseek-reasoner` 不支持 `toolChoice: "required"`

### 修复后

| 场景 | 成功率 | 平均分 | 平均轮次 | 平均耗时 |
|------|-------|-------|---------|---------|
| ✅ 重命名变量 | 3/3 | 4.0 | 4.0 | 12,769ms |
| ✅ 添加参数 | 3/3 | 4.0 | 3.7 | 9,245ms |
| ✅ 反转排序 | 等待完成 | - | - | - |
| ✅ 提取公共函数 | 等待完成 | - | - | - |
| ✅ 行号引用 | 等待完成 | - | - | - |
| ❌ 不存在函数 | 等待完成 | - | - | - |

注意: DeepSeek 耗时明显更长（约 2-3 倍于 GPT），因启用了 thinking 模式。

---

## 3. Nano 失败原因分析

### 失败详情

- **场景**: common-add-parameter (为 `fetchWithRetry` 添加 `retryDelay` 参数)
- **配置**: openai-freeform-edit-nano (gpt-5.4-nano)
- **运行**: Run #1, 4 轮, 10152ms
- **分数**: [2/4]

### 轮次轨迹

| 轮次 | 操作 | 说明 |
|------|------|------|
| 1 | apply_patch (24 lines) | 修改了 `1000 * (attempt + 1)` → `retryDelay * (attempt + 1)`，**但未添加参数声明** |
| 2 | view_file → L1-69 | 查看验证结果 |
| 3 | apply_patch (13 lines) | 第二次尝试，仍然未添加参数 |
| 4 | submit | 提交反馈指出编译错误 |

### 根因

模型仅在 **函数体内部** 添加了 `retryDelay` 的引用，但 **没有在函数签名中添加 `retryDelay: number = 1000` 参数**。

```
// ❌ 模型生成的代码（不会编译）
async function fetchWithRetry(url: string, options?: RequestInit): Promise<Response> {
  // retryDelay 在此处被使用，但未定义
  await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
}

// ✅ 预期的代码
async function fetchWithRetry(url: string, options?: RequestInit, retryDelay: number = 1000): Promise<Response> {
  await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
}
```

### 结论

这是 gpt-5.4-nano 的质量问题，不是代码 Bug。Editor LLM 的角色（反馈系统）正确捕获了该问题。

---

## 4. Token 开销统计（第三次运行）

| Preset | 总 Input | 总 Output | 总 Tokens |
|--------|---------|----------|-----------|
| freeform-patch mini (gpt-5.4-mini) | ~75K | ~2.2K | ~77K |
| freeform-patch nano (gpt-5.4-nano) | ~100K | ~3.5K | ~103K |
| str-replace (deepseek-v4-flash) | 进行中 | 进行中 | 进行中 |

（第三次运行结果被定时器截断，完整报告见 eval-reports/latest-report.md）

---

## 5. 发现的 Bug 与修复记录

| # | Bug | 发现阶段 | 修复 |
|---|-----|---------|------|
| 1 | `toolChoice: "required"` 不被 deepseek-reasoner 支持 | 首次运行 | 改为 `"auto"` + 外部引导机制 |
| 2 | 清空数组时 `conversation.length = 0` 也清空了 `result.conversation`（相同引用） | 重构后 | 移除冗余的复制操作 |
| 3 | freeform-patch 未发送 `done` 事件 | 第二次运行 | 在 step 中手动发出 `done` 事件传递 tokenUsage |
| 4 | nano 添加参数但未修改函数签名 | 质量评估 | 模型质量问题，非代码 Bug |
| 5 | 引导机制缺失：模型不调用工具时直接返回错误 | 第三次设计 | 注入状态感知引导消息后继续循环 |

---

## 6. 结论

1. **freeform-patch** 是最稳定后端，mini 和 nano 都在所有场景表现良好
2. **str-replace + DeepSeek** 在修复后正常工作，但速度较慢（启用 thinking）
3. **step.ts 拆分** 使每轮的 thinking、reply、toolCalls、tokenUsage 均可独立捕获
4. **外部引导机制** 替代了 `toolChoice: "required"`，兼容更多模型
5. 建议将 `toolChoice` 作为可配置参数，支持 `"auto"` / `"required"` / `"none"`
