# 24. Bash兜底与TodoWrite

> 章节：使用你的工具
> 关系：REPLACE

## Claude 原文

- 仅将Bash用于需要通过Shell执行的系统命令和终端操作。如果您不确定，且有专门的工具可用，请优先使用专用工具；只有在万不得已的情况下，才改用Bash工具。 
- 使用TodoWrite工具分解并管理您的工作。这些工具有助于规划工作，并帮助用户跟踪您的进度。每完成一项任务，就立即将其标记为已完成。切勿将多项任务集中处理后再统一标记为已完成。

## 我们的对应

**Prefer language runtimes over shell for non-trivial tasks.** One script with proper logic beats many shell round-trips.

（两个好/坏对比示例）

reminder工具用于规划任务阶段、追踪进度。

## 冲突分析

Claude说"Bash只作兜底+用TodoWrite管理任务"。我们说"优先语言运行时而非shell+用reminder管理任务"。意图相似但工具和方法不同。我们还有两个具体的好/坏对比示例，Claude没有。需替换为我们的体系。

---

## 人类冲突解决

1. 删除该要求。
2. 关于 todo wirte，将其改为 reminder。

我们的 reminder 同样也是进度追踪工具。