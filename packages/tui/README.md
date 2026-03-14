# @n0n/tui

基于 Ink (React for CLI) 的 Terminal UI 渲染器。

## 解决的问题

当前 `@n0n/cli-ui` 的 diff 模式渲染存在以下问题：

1. **终端自动换行导致光标错位** - `LiveRegion` 基于 `\n` 计数计算光标移动，无法处理终端自动换行
2. **多工具输出混乱** - 所有工具共用一个 `toolRegion`，输出互相干扰
3. **输入/渲染冲突** - `readline` 和 `Renderer` 同时向 stderr 输出，用户输入时渲染会覆盖提示符

## 解决方案

使用 Ink (React for CLI) 提供：

- **声明式组件** - 输入/输出区域完全隔离
- **自动布局** - Ink 自动处理终端换行和光标定位
- **React 状态管理** - 天然支持多区域独立更新

## 使用方式

### 基本用法

```tsx
import { TuiRenderer } from "@n0n/tui";

const renderer = new TuiRenderer({
  onUserInput: (text) => {
    console.log("User input:", text);
  }
});

// 实现 Renderer 接口的方法
renderer.userMessage("Hello");
renderer.roundStart(1, 10, 1);
renderer.thinkingToken("Thinking... ");
renderer.contentToken("Here is my response. ");
renderer.contentEnd();
renderer.submitAccepted();

// 清理
renderer.dispose();
```

### 作为 Renderer 接口实现

`TuiRenderer` 实现了 `@n0n/types` 中的 `Renderer` 接口，可以直接替换 `RichRenderer`：

```ts
import { TuiRenderer } from "@n0n/tui";
import { agentLoop } from "@n0n/core";

const renderer = new TuiRenderer();
const result = await agentLoop(history, { renderer, ... });
renderer.dispose();
```

## 组件结构

```
TuiApp
├── 轮次信息
├── 消息历史
│   └── MessageRow (user/agent/thinking/content/tool/system)
├── 流式内容
│   └── StreamingContent (thinking/content buffer)
├── 工具输出
│   └── ToolOutput (参数/状态/输出/结果)
├── 最终状态
│   └── FinalStatus (accepted/rejected/terminated/aborted)
└── 输入框
    └── InputBox (支持多行输入)
```

## 开发状态

- [x] 基础包结构
- [x] 状态管理 (state.ts)
- [x] 消息显示组件
- [x] 工具输出组件
- [x] 流式内容组件
- [x] 输入处理组件
- [ ] 在 code app 中集成
- [ ] 处理终端大小变化
- [ ] 处理 Ctrl+C 中断
