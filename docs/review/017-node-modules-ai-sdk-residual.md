# Review Issue #017: node_modules 中残留 AI SDK 包

## 严重程度：低（部署/CI 清理问题）

## 位置
- `node_modules/ai/`
- `node_modules/@ai-sdk/`

## 描述

虽然所有 `package.json` 和 `bun.lock` 中已不包含 AI SDK 相关依赖，但 `node_modules` 目录中仍存在：
- `node_modules/ai/` （含 CHANGELOG, dist, src 等）
- `node_modules/@ai-sdk/anthropic`
- `node_modules/@ai-sdk/google`
- `node_modules/@ai-sdk/openai`

这说明移除依赖后没有执行 `bun install` 或 `rm -rf node_modules && bun install` 来清理。

## 影响

不影响运行（代码中已无 import），但：
1. 占用磁盘空间
2. 可能在 IDE 中产生错误的自动补全建议
3. 如果有人误引入，不会在开发环境报错

## 建议

执行一次 `rm -rf node_modules && bun install` 确保 node_modules 与 lockfile 一致。在 CI 中通常从 clean 状态安装，不会有此问题。
