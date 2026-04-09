# @n0n/render-buffer

// TODO: 从 packages/core/src/agent/render-buffer.ts 抽离而来的独立模块。

## 背景

core 层的 Renderer 接口将改为接收 raw 无序事件（带 tcId），排序职责下放给消费者。
RenderBuffer 作为可选的顺序化适配器，供需要 FIFO 有序渲染的消费者使用（如 CLI 的 RichRenderer）。

## 计划

- [ ] 将 `packages/core/src/agent/render-buffer.ts` 迁移到本模块
- [ ] Renderer 接口的 `toolExecChunk`、`toolExecEnd` 补充 `tcId` 参数
- [ ] scheduler 移除 `attachRenderBuffer`，改为事件回调接口（`onChunk`、`onEnd`）
- [ ] RichRenderer 通过本模块做 FIFO 排序后再渲染
- [ ] PlainRenderer / WebUI Renderer 直接消费 raw 事件
- [ ] 迁移 `packages/core/src/agent/__tests__/pipeline.test.ts` 中 RenderBuffer 相关测试
