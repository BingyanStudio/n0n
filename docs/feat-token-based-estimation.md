# 基于 token 预估替代字符长度

## 动机

当前代码中大量使用 `string.length`（字符数）做截断判断和展示，但 LLM 实际消耗的是 token 而非字符。字符数与 token 数之间存在显著偏差：

- 英文单词 `"hello"` = 5 chars = 1 token
- 中文 `"你好"` = 2 chars = 2 tokens
- 乱码/特殊字符可能每字符消耗 1-3 tokens
- JSON 结构 `{"script":"ls"}` = 15 chars ≈ 6 tokens

这意味着用字符数做截断阈值，对不同内容类型的实际 token 开销差异可达 3-5 倍。

## 工具选择

使用 [tokenx](https://www.npmjs.com/package/tokenx)：
- 2kB 体积，无依赖
- 96% 精准度（对比完整 tokenizer）
- 纯计算，无 WASM/native 依赖，性能极好

## 接入点分类

### 第一类：逻辑判断 — 改用 token 预估

这些地方用字符长度做决策，直接影响模型看到的上下文大小，应改为 token 预估。

| 位置 | 当前逻辑 | 改为 |
|------|----------|------|
| `executor.ts` TRUNCATION_THRESHOLD | `stdout.length + stderr.length > 8000` chars | `estimateTokens(stdout + stderr) > 2000` tokens |
| `executor.ts` TAIL_LENGTH | `tail(s, 2000)` chars | `tailByTokens(s, 500)` tokens |
| `executor.ts` stdoutSoFar/stderrSoFar | `tail(s, TAIL_LENGTH)` chars | 同上 |
| `rag.ts` 内容截断 | `fullContent.slice(0, 2000)` chars | `sliceByTokens(fullContent, 500)` tokens |

### 第二类：仅展示 — 额外显示 token 预估

这些地方仅用于人/开发者查看，改为展示更有意义的 token 预估。

| 位置 | 当前展示 | 改为 |
|------|----------|------|
| `rich-renderer.ts` exec completed | `89 chars` | `~25 tokens` |
| `rich-renderer.ts` text response | `120 chars` | `~30 tokens` |
| `rich-renderer.ts` reminder | `45 chars` | `~12 tokens` |
| `feishu/renderer.ts` | 无长度展示 | 可选添加 |
| `format-prompt.ts` truncated 提示 | `last 141 of 28450 chars` | `last ~35 of ~7100 tokens` |

### 第三类：真实数据可用 — 保持不变

这些地方已经使用 LLM API 返回的真实 token 用量，不需要改：

| 位置 | 数据来源 |
|------|----------|
| `RoundTokenUsage` | API response `usage.input_tokens` / `output_tokens` |
| `fairy/view.ts` 预估 | 已用 `chars / 3` 粗估，可改用 tokenx 提升精准度 |

## 实现方案

### 1. 新增 @n0n/shared 中的 token 工具函数

```typescript
// packages/shared/src/tokens.ts
import { estimateTokenCount } from "tokenx";

/** 预估字符串的 token 数 */
export function estimateTokens(text: string): number {
    return estimateTokenCount(text);
}

/** 从字符串末尾截取约 n 个 token 的内容 */
export function tailByTokens(text: string, maxTokens: number): string {
    // 粗略估算每 token 平均 4 字符，取 1.5 倍余量
    const estimatedChars = maxTokens * 6;
    const candidate = text.length > estimatedChars
        ? text.slice(-estimatedChars) : text;
    // 如果仍超出，逐步缩小
    // （tokenx 很快，可以迭代几次）
    return candidate;
}

/** 从字符串开头截取约 n 个 token 的内容 */
export function headByTokens(text: string, maxTokens: number): string {
    const estimatedChars = maxTokens * 6;
    const candidate = text.length > estimatedChars
        ? text.slice(0, estimatedChars) : text;
    return candidate;
}

/** 格式化 token 数展示 */
export function formatTokens(text: string): string {
    return `~${estimateTokens(text)} tokens`;
}
```

### 2. tokenx 安装位置

安装在 `@n0n/shared`，因为 format-prompt.ts 和 executor.ts 都依赖 @n0n/shared。

```bash
cd packages/shared && bun add tokenx
```

### 3. 类型影响

ExecTruncated 中的 `stdoutLength` / `stderrLength` 字段：
- 当前是字符数，语义是"原始输出有多大"
- 改为 token 预估数更有实际意义
- 字段名改为 `stdoutTokens` / `stderrTokens`

```typescript
interface ExecTruncated extends ExecResultBase {
    status: "truncated";
    exitCode: number;
    stdoutTail: string;
    stderrTail: string;
    outputFile: string;
    /** 原始 stdout 预估 token 数 */
    stdoutTokens: number;
    /** 原始 stderr 预估 token 数 */
    stderrTokens: number;
}
```

## 收益

1. **截断阈值更精确**：2000 tokens 的阈值对英文/中文/代码内容表现一致，不会因为中文字符少而过早截断，也不会因为英文字符多而放过大量 token
2. **展示更有意义**：开发者看到 `~25 tokens` 比 `89 chars` 更能判断 context 开销
3. **与 LLM API 预算对齐**：模型上下文窗口以 token 计，预估 token 数可直接对比

## 风险

1. **tokenx 预估偏差**：96% 准确度意味着有 4% 偏差，但对于截断判断来说完全足够
2. **性能**：tokenx 是纯计算，对于 8k 字符的输出估算耗时微秒级，可忽略
3. **依赖新增**：tokenx 无依赖、2kB，极轻量
