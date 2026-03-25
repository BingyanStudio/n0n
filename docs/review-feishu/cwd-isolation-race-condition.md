# runWorkflow 的 CWD 隔离存在进程级竞态条件

## 严重程度：高

## 状态：✅ 已修复 (e770119)

## 问题描述

`runWorkflow` 使用 `process.chdir()` 实现 CWD 隔离，但这是**进程全局操作**。当多个 workflow 并发执行时（不同用户 scheduler 同时触发、用户对话与 scheduler 重叠），它们会互相覆盖 `process.cwd()`，导致 CWD 隔离失效。

## 修复方案

使用 `Bun.spawn` 在独立子进程中执行需要 CWD 隔离的 workflow：

- 新增 `runner.ts` 作为子进程执行入口
- `runWorkflowIsolated()` 通过 `Bun.spawn({ cwd })` 启动子进程
- 结果通过临时文件传递（避免与 workflow stdout 混淆）
- 完全移除 `process.chdir` 相关代码

每个 workflow 在独立进程中运行，真正实现进程级 CWD 隔离。

## 相关文件

| 文件 | 说明 |
|------|------|
| `packages/workflow/src/workflow/runner.ts` | 新增：子进程执行入口 |
| `packages/workflow/src/workflow/runtime.ts` | 修改：用 Bun.spawn 替代 process.chdir |
