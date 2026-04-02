# TODO

代码是唯一事实来源，本文件仅追踪**尚未实现的改进计划**，完成后应从此处删除对应条目。

---

## ~~1. cli-ui/LiveRegion: 从被动估算折行到主动 wrap~~ ✅ 已完成

> **已在 `fix/live-region-wrap` 分支完成。** 引入 `wrap-ansi`，移除 `countDisplayLines` 估算逻辑，45 个测试全部通过。

**问题：** `LiveRegion` 通过 `visibleWidth / terminalColumns` 事后估算终端自动折行的行数，CJK/emoji/ANSI 混合内容下容易算错，导致 `clear()` 清除行数不匹配（残留或吞内容）。

**方案：** 引入 `wrap-ansi`，在写入前主动将文本按终端宽度 wrap，然后直接数 `\n` 得到精确行数。参考 `log-update` 的实现（周下载 3400 万+）：

```
wrap-ansi(text, terminalWidth) → split('\n').length → eraseLines(count)
```

**影响范围：** 不只是 `LiveRegion` 一处——整个 cli-ui 模块应该从"被动响应终端折行"转变为"主动控制折行"：
- `LiveRegion.writeln()` — 写入前先 wrap，行数计数基于 wrap 后的 `\n`
- `LiveRegion.countDisplayLines()` — 可以移除，不再需要事后估算
- `RichRenderer` 中所有通过 LiveRegion 输出的内容 — 自动受益
- 流式工具参数的滚动窗口 (`renderToolArgsStreaming`) — wrap 后截断更精确

**依赖：** `wrap-ansi` (npm)

---

## ~~2. multiline-input: 集成到 apps/code~~ ✅ 已完成

> **已在 `test/multiline-input-interactive` 分支完成。** 替换旧的 readline + 时间阈值方案为 `@n0n/multiline-input`（raw mode + bracketed paste），修复折行渲染问题，Ctrl+C 不再退出进程。

**前置：** `@n0n/multiline-input` 包已创建（`feat/multiline-input` 分支），待 review 通过后集成。

**步骤：**
- `apps/code/src/repl.ts` 中替换 `readMultilineInput`（从 `./multiline-input.ts` 改为 `@n0n/multiline-input`）
- 移除旧的 `apps/code/src/multiline-input.ts`（readline + 时间阈值方案）
- 调整 Ctrl+C 行为：当前 repl.ts 在 `rl.on('SIGINT')` 中处理中断，新方案下需要在 reader 返回 null 时判断是否中断 agent

---

## ~~3. code-renderer: 流式 write 预览的 path 过早锁定 BUG~~ ✅ 已修复

> **已在 `fix/code-renderer-path-lock` 分支修复。** path 锁定延迟到 content key 出现后，5 个测试覆盖。

**问题：** `CodeRenderer.flushPreview()` 使用 `partial-json` 解析流式 JSON 参数，在 path 值尚未传输完整时就锁定了文件路径。

**复现：** LLM 逐 token 输出 `{"path": "tsconfig.json", "content": "..."}` 时：
- chunk 2 累积为 `{"path": "ts` → `partial-json` 解析出 `path: "ts"`（补全了闭合引号）
- CodeRenderer 的"首次解析到即锁定"逻辑将 `targetPath` 锁定为 `"ts"`
- 后续 chunk 补全为 `"tsconfig.json"` 但 path 已不再更新
- 结果：content 被写入 `./ts` 文件（垃圾文件），而非 `./tsconfig.json`

**根因：** `partial-json` 对未闭合字符串会自动补全闭合引号，因此在字符串值传输过程中每次都能解析出一个"看似完整"但实际截断的值。而代码中的 `if (!preview.targetPath && ...)` 锁定逻辑无法区分"值已完整"和"值被 partial-json 补全"。

**修复方案：** 不在流式阶段锁定 path，改为每次 flush 都从最新解析结果中取 path。或者检测 path 值后面是否已有下一个 key（如 `content`），以此判断 path 值是否已完整传输。

```typescript
// 方案 A：不锁定，每次取最新（简单但可能写入多个临时文件名）
// 方案 B：检测 path 完整性 — 当 parsed 中同时存在 path 和 content 时才开始写入
if (typeof parsed.path === "string" && parsed.path && "content" in parsed) {
  // path 已完整（因为 content key 已开始传输）
  preview.targetPath = this.resolvePath(parsed.path);
}
```

方案 B 更优：只有当 `content` key 出现时，才说明 `path` 的值已完整传输完毕，此时锁定 path 并开始流式写入 content。

