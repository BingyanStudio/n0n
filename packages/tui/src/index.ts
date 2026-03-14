/**
 * @n0n/tui — Terminal UI 渲染器
 *
 * 基于 Ink (React for CLI) 的 TUI 实现。
 * 解决 diff 模式渲染的核心问题：
 * 1. edit/write 大量行输出时的光标错位
 * 2. 多工具并行执行时的输出混乱
 * 3. 用户输入换行时的渲染冲突
 */

export { TuiRenderer } from "./renderer.tsx";
export { createInitialState, type TuiRendererState } from "./state.ts";
