# tsconfig.json 生成逻辑在自定义路径下失效

## 严重程度：中

## 状态：✅ 已修复 (5b61920)

## 问题描述

`paths.ts` 中 `projectRoot = resolve(FEISHU_BASE, "..", "..")` 硬编码了目录层级，当使用 `N0N_FEISHU_WORKSPACE` 自定义路径时，生成的 tsconfig extends 路径指向错误位置。

## 修复方案

新增 `findProjectRoot()` 函数，通过多级回退策略查找项目根目录：

1. **import.meta.dir**：基于源文件位置推算（编译时确定，最可靠）
2. **process.cwd()**：基于当前工作目录
3. **向上查找**：从 FEISHU_BASE 向上遍历，查找包含 `tsconfig.json` 的目录

同时增加了安全检查：只在确认 `rootTsconfig` 存在时才生成 extends。

## 附带清理

移除了废弃的 `UserInputMessage.capabilities` 字段（已被 skills 注入取代），涉及 types/shared/cli 三个包。

## 相关文件

| 文件 | 说明 |
|------|------|
| `apps/feishu/src/paths.ts` | findProjectRoot() + tsconfig 生成修复 |
| `packages/types/src/domain.ts` | 移除 capabilities 字段 |
| `packages/shared/src/format-prompt.ts` | 移除 capabilities 处理 |
