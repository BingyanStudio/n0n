---
name: set-cronjob
description: 设置定时任务，n0n 运行时提供了一个内置的定时触发器，可以监控 `workflows/schedules/` 目录下的 `.mdc` 文件，根据其中定义的 cron 表达式定时执行任务。可以通过创建或修改 `.mdc` 文件来设置、更新或删除定时任务，无需重启服务。
metadata:
  author: n0n
  version: "1.0"
---

# 定时触发器 — MDC 文件驱动

n0n 运行时提供了一个内置的定时触发器，可以监控 `workflows/schedules/` 目录下的 `.mdc` 文件，根据其中定义的 cron 表达式定时执行任务。可以通过创建或修改 `.mdc` 文件来设置、更新或删除定时任务，无需重启服务。

当遇到“每天早上8点提醒我喝水”，“每1小时提醒我站立一次”这样的需求时，可以创建一个 `.mdc` 文件，内容如下：

```markdown
---
name: task-name
cron: "0 8 * * *"
enabled: true
workflow: workflows/tasks/xxx.ts  # 可选，有则直接运行 workflow
---
提示词内容（当无 workflow 字段时，作为 delegateTask 的 query）
```