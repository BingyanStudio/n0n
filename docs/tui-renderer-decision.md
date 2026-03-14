# TUI 渲染器技术决策

## 背景

当前 CLI 工具基于 diff 模式渲染，存在以下问题：

1. `LiveRegion` 基于换行符计数计算光标移动，无法处理终端自动换行
2. 多个工具共用一个 `toolRegion`，输出混乱
3. `readline` 和 `Renderer` 同时向 stderr 输出，用户输入时渲染冲突

## 评估方案

### Ink (React for CLI)

**优点**：
- 声明式组件模型，输入/输出区域完全隔离
- 自动处理终端换行和光标定位
- React 生态，熟悉度高

**缺点**：
- 与现有 readline 输入模型冲突
- Ink 的 `useInput` 和 node:readline 同时监听 stdin 会产生竞争
- 需要完全重构 REPL 循环才能正确集成

## 决策

**暂缓 TUI 迁移**，原因：

1. **输入冲突未解决**：Ink 的输入处理与现有 readline 模型不兼容，需要重新设计整个 REPL 循环
2. **ROI 不足**：当前 RichRenderer 已能满足大部分需求，问题主要出现在极端场景
3. **复杂度高**：完整集成需要重构 REPL、处理 TUI 生命周期、解决 Ink 与 readline 的竞争

## 替代方案

1. 改进 `LiveRegion`：计算实际显示高度而非换行符数量
2. 分离输出区域：为每个工具创建独立的 `LiveRegion`
3. 输入锁定：用户输入时暂停渲染输出
