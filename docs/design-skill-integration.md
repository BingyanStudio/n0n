# 设计文档：Agent Skills 集成

## 概述

集成 Agent Skills 规范，让不同类型的任务自动获得对应的行为方法论。替代当前的 `--v` 手动提示词版本切换。

## 动机

不同任务需要不同的方法论：bugfix 需要强制诊断流程，编码需要最小化行动，讨论需要系统分析框架。当前通过 `--v` 手动切换——每次要判断"该用哪个版本"，是认知负担。

## 什么是 Agent Skills

一个 skill 是一个文件夹，包含 `SKILL.md` 文件：

```
bugfix/
├── SKILL.md          # 必须：元数据 + 方法论指令
├── scripts/          # 可选：可执行脚本
└── references/       # 可选：参考文档
```

SKILL.md 包含 YAML frontmatter 和 Markdown 正文：

```markdown
---
name: bugfix
description: 当任务涉及修复 bug、排查错误、定位问题时使用。
activation: auto
---

# Bugfix 方法论

## 格物——穷尽问题的本质
**硬约束**：不要执行任何修改。
...
```

### frontmatter 字段

| 字段 | 必须 | 说明 |
|------|------|------|
| name | 是 | skill 标识符 |
| description | 是 | 何时使用此 skill |
| activation | 否 | `auto`（默认）或 `manual`。manual 的 skill 不出现在 help 列表中，但可以通过 `@name` 和 `read` 使用 |

**activation 字段的作用**：
- `auto`：出现在 `n0n-skill help` 的列表中，模型可以自主发现和激活
- `manual`：对 help 列表隐藏。只能通过用户 `@name` 显式唤起或模型 `n0n-skill read` 显式读取。适用于不想让模型自动触发的 skill（如实验性方法论、特定项目专用的 skill）

### Progressive Disclosure

三层逐步加载：
1. **Discovery**：`n0n-skill help` 只展示 auto skill 的 name + description
2. **Activation**：加载完整 SKILL.md 正文
3. **Execution**：按需执行 scripts/ 中的脚本、读取 references/

## 设计

### 部分一：用户侧唤起（@name 语法）

在 apps/code 的 REPL 中，用户输入的独占一行的 `@name` 被识别为 skill 唤起。

**必须独占一行**——避免复制 debug 日志、代码片段等内容时被错误识别。

**示例**：
```
@bugfix
这里的UI排版有问题
```

**行为**：
1. 解析输入中所有独占一行的 `@name`
2. 对每个 name，调用 n0n-skill 的接口读取对应 SKILL.md 内容
3. 将内容作为 hint 字段注入该条用户消息
4. `@name` 行从用户可见的消息文本中移除
5. 如果 name 找不到，提示用户并列出可用 skill

**关键**：apps/code 的 @name 注入逻辑必须基于 apps/n0n-skill 提供的接口来读取 skill 内容，确保两边行为一致。

### 部分二：模型侧 CLI 工具（apps/n0n-skill）

独立的 bun CLI 应用，与 apps/code 捆绑分发。模型通过 exec 调用。

**存储**：

全局配置目录 `~/.n0n/` 下：
- `builtin-skills/` — 内置 skill，由 `n0n-skill init` 写入
- `skills/` — 用户自定义和安装的 skill

加载时扫描两个目录。skill 文件写入本地磁盘——因为 skill 可能包含可执行脚本，模型需要通过绝对路径执行。

**命令**：

```bash
# 初始化：将内置 skill 写入 ~/.n0n/builtin-skills/
n0n-skill init

# 帮助 + 列出可用 skill
# 只列出 activation=auto 的 skill（manual 的不显示）
# 输出包含指令：引导模型在响应用户前检查是否有合适的 skill
n0n-skill help

# 读取指定 skill 的完整内容（auto 和 manual 都可以读）
n0n-skill read <name>

# 安装远程 skill
n0n-skill install <source>

# 创建新 skill 脚手架
n0n-skill create <name>
```

**help 的设计**：
- 列出所有 activation=auto 的 skill（name + description）
- 输出末尾包含一段引导文本："在响应用户请求前，检查是否有合适的 skill 可以加载。使用 `n0n-skill read <name>` 获取完整方法论。"
- 这实现了 progressive disclosure 的模型侧触发

### skill 的 Discovery 注入

在初始化 context fewshot 流程中，模仿 AI 执行：

```bash
n0n-skill help || n0n-skill.exe help || echo "n0n-skill 不可用"
```

将输出注入 context fewshot。如果 n0n-skill 可用，模型自然看到 skill 列表和使用指令；如果不可用，模型知道没有 skill 系统。

不需要在 system prompt 中硬编码列表——由 CLI 工具的实际输出驱动。

## 与现有 --v 机制的关系

短期共存：`--v` 控制基础 system prompt，`@name` 在其上叠加 skill。

长期：`--v` 废弃，不同"版本"拆解为 skill 组合。

## 与 progress 工具的关系

skill 定义"怎么做事"（方法论），progress 定义"怎么汇报进展"（交互协议）。两者独立但互补：skill 可以在方法论中引导模型使用 progress(working) 汇报阶段性进展。

## 改动清单

1. `apps/n0n-skill/`：新建独立 CLI 应用（init/help/read/install/create）
2. `apps/code/src/repl.ts`：解析独占一行的 `@name`，通过 n0n-skill 接口读取并注入 skill 内容
3. context fewshot 初始化流程中注入 `n0n-skill help` 的执行结果
4. `~/.n0n/builtin-skills/`：编写内置 skill（bugfix、refactor、discuss 等）
5. 将 `apps/code/src/prompts/code-v0.1.md` 内容迁移为 bugfix skill 格式
6. 提示词中增加 skill 使用说明

## 实现状态

| 改动项 | 状态 | 备注 |
|--------|------|------|
| `apps/n0n-skill/` CLI 应用 | ✓ 已实现 | init/help/read/install/create 全部完成 |
| `packages/shared/src/skills/` 增加 activation | ✓ 已实现 | 新增 SkillActivation 类型 + discoverSkillsMultiDir |
| `apps/code/src/repl.ts` @name 解析 | ✓ 已实现 | 通过 skill-inject.ts 模块 |
| context fewshot 注入 skill help | ✓ 已实现 | Turn 1 并行 exec 中加入 |
| 内置 skill (bugfix/refactor/discuss) | ✓ 已实现 | apps/n0n-skill/builtin/ |
| 迁移 code-v0.1.md 为 skill | ✓ 已实现 | bugfix skill 提炼了认知五步核心 |
| 提示词说明 | ✓ 已实现 | 通过 fewshot exec 输出自然引导，无需硬编码 |
