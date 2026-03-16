# Edit 工具重命名实验记录：edit → vim_edit

> 日期：2026-03-15 | 分支：refactor/edit-tool-redesign | 结论：**失败，已 revert**

## 背景

模型在使用 Vim ex 命令编辑文件时频繁出错。根因分析指向三个结构性问题：

1. **正则方言冲突**：模型训练数据 ~60% 是 PCRE/JS 正则，Vim magic mode（`(` 字面量、`\(` 分组）与模型先验概率相反
2. **有状态游标**：多条 ex 命令共享隐式游标位置，第一条 `:c` 后游标移动导致后续 pattern 从错误位置搜索
3. **转义层叠加**：JSON string escaping × Vim pattern escaping × `:s` delimiter escaping = 2-3 层同时推理

## 假设

> 模型填写参数时，因为参数名 `commands` 过于通用，导致 TS/JS 语法先验被激活，与 Vim 语法混淆。
> 将工具名改为 `vim_edit`、参数名改为 `vim_command`，可以显式激活 Vim 专属先验知识，减少语法混入。

## 实验

### 变更内容

- 工具名：`edit` → `vim_edit`（tool definition, registry, renderers, 15 处字符串字面量）
- 参数名：`commands` → `vim_command`（Zod schema, 实现, 测试, 描述）
- TypeScript 符号：`EditArgsSchema` → `VimEditArgsSchema` 等（ts-morph 自动重命名 6 个符号）
- 更新所有 prompt 和文档引用
- 共 17 文件，152+/136- 行

### 测试结果

| 指标 | 结果 |
|------|------|
| **首次成功率** | 15/26 (57.7%) |
| **重试成功率** | 3/11 (27.3%) |
| 总测试数 | 26 |

### 易错问题（未因重命名改善）

1. **append 命令 (`:a`) 不工作** — SIGTERM / E488 错误
2. **多行替换语法复杂** — `:c` 命令的地址格式和 `.` 终止符
3. **转义字符问题** — 反斜杠导致解析错误
4. **正则匹配失败** — pattern 不存在时错误信息不够明确
5. **部分替换导致代码不一致** — 变量名部分替换破坏逻辑

### 稳定功能

- `%s/old/new/g` 全局替换
- `g/pattern/d` 删除匹配行
- 行号定位编辑 (`Nc`)
- `:i` 插入命令

## 结论

**重命名无效**。仅改名不足以解决 Vim 的结构性问题：

1. 正则方言冲突是训练数据分布问题，不是命名问题
2. 有状态游标和转义叠加是 Vim 架构固有的复杂度
3. `:a` 命令的 SIGTERM 问题说明 nvim headless 本身存在兼容性问题

## 下一步方向

仅改名是"治标"尝试，已验证无效。需要"治本"：

### 方案 A：混合工具集（替换 Vim）
- 增强版 search/replace（字面量子串匹配 + 模糊回退）用于小修改
- pattern-addressed block replace（结构化 JSON，无 Vim 语法）用于块替换
- 纯 Bun 实现，去掉 nvim 依赖，完全控制错误消息

### 方案 B：改进错误消息（保留 Vim）
- 富上下文错误："Pattern `X` not found. Similar: `Y` (line N)"
- 限制可用命令集（只暴露稳定的 `%s`, `g//d`, `Nc`, `:i`）
- 对 `:a` 等不稳定命令做前置拦截

### 方案 C：放弃精确编辑
- 小文件直接用 `write` 重写
- 大文件用 `exec` + `sed` / `bun` 脚本编辑
- edit 工具降级为建议性质，不作为主要编辑方式

## 附录：实验 commit 记录

```
f2599c9 refactor(edit): rename edit→vim_edit, commands→vim_command
51fef9b Revert "refactor(edit): rename edit→vim_edit, commands→vim_command"
```
