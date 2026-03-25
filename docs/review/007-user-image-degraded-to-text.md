# 007 — user_image 降级为纯文本，丢失图像数据

**初评严重度**: 🟢 低（功能退化）
**二次审查**: 🟢 **维持 — 功能缺失，低优先级**
**文件**: `packages/shared/src/format-prompt.ts`

## 初评描述

`formatPrompt` 将 `user_image` 消息转换为纯文本 `[Image: path]`，丢弃了结构化的图像数据。

## 二次审查

### 1. 问题确实存在

`UserImageMessage` 包含 `imagePath`、`focusX`、`focusY`、`scale` 等字段，全部被静默降级为文本占位符。如果用户发送图片，LLM 看到的只是路径字符串。

### 2. 但这是一个功能需求，不是架构问题

初评将其归类为「关注点分离不足」有些牵强。真正的问题是：**图像支持尚未实现**。这不是一个架构设计错误，而是一个待开发的功能。

### 3. 当前处理是安全的降级

在图像支持实现之前，降级为文本是合理的——至少 LLM 知道用户提到了一张图片（路径信息），不会完全丢失上下文。比静默忽略要好。

### 4. 实现图像支持的正确路径

当需要时：
1. `PromptMessage` 增加 content parts 支持（`{ type: "image_url", ... }`）
2. `formatPrompt` 将 `user_image` 转换为带图像 URL/base64 的 content part
3. 各 Client 的格式转换函数处理图像 content part

这是一个完整的功能开发，不是一个 bugfix。

## 结论

**暂不行动**。当前降级行为是安全的。可以考虑添加一条 debug 级别日志，提示图像数据被降级。图像支持作为独立功能需求追踪。
