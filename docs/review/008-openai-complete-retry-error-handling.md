# Review Issue #008: OpenAI complete() 与 Anthropic complete() 重试逻辑不一致

## 严重程度：低

## 位置
- `packages/llm/src/openai-client.ts` (L370-410)
- `packages/llm/src/anthropic-client.ts` (L470-510)

## 描述

两个 Client 的 `complete()` 方法在错误处理上存在不一致：

### OpenAI complete() (L400):
```ts
catch (err) {
    if (err instanceof LLMError) throw err;  // 非重试错误直接抛
    lastError = err instanceof Error ? err : new Error(String(err));
}
```
非 LLMError 异常（如网络错误）会被捕获并重试。

### Anthropic complete() (L506):
```ts
catch (err) {
    if (err instanceof Error && !err.message.startsWith("Anthropic API")) {
        lastError = err;
    } else {
        throw err;
    }
}
```
这里的逻辑是：如果错误消息以 "Anthropic API" 开头则直接抛出，否则记录为 lastError 重试。但这有问题 — 4xx 非重试错误（如 400、401）在前面被 `throw new Error(...)` 抛出时，消息格式为 `"Anthropic API 400: ..."` 会以 "Anthropic API" 开头，于是直接抛出，这是正确的。但 429/5xx 错误使用 `lastError = new Error(...)` 赋值，消息也以 "Anthropic API" 开头 — 可 429/5xx 不会走到 catch 块（它们 `continue` 了），所以逻辑虽然绕但实际不会出错。

不过代码可读性较差，两个 Client 的错误处理模式不统一。

## 建议

统一两个 Client 的 `complete()` 重试和错误处理模式。建议参考 OpenAI Client 使用专用 `LLMError` 的模式。
