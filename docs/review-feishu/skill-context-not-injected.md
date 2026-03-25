# Skills 上下文未注入到 Agent 对话

## 问题描述

飞书模式下，Agent 在每轮对话中**不知道有哪些 skill 可用**。系统只在 runtime context 中注入了 skills 目录的绝对路径，但没有注入 skill 的 name、description 等元数据摘要。

## 实际行为

### 注入的内容（`session.ts` → `buildFeishuSystemContext`）

```
- skills (shared, read-only, outside workspace; absolute path): `/abs/path/.runtime/feishu/shared/skills`
```

仅一行路径字符串。Agent 不知道这个目录下有哪些 skill，也不知道每个 skill 的用途。

### 缺失的内容

`round.ts` 的上下文收集阶段（L68-98）只做了三件事：
1. `discoverWorkflows` — 发现已有 workflow ✅
2. `loadSchedules` — 发现已有定时任务 ✅
3. `loadAgentsMd` — 加载 AGENTS.md ✅

**没有调用 `discoverSkills` 或 `loadSkillContents`**。这两个函数在 `@n0n/shared` 中已经存在且功能完善，只是没有在飞书 round 中使用。

### 对比：已有的 skill 发现能力

`@n0n/shared` 提供了完整的 skill 发现链：

```typescript
// 这些函数已经存在，但 round.ts 没有调用
discoverSkills(baseDir)        // → SkillMeta[]（name, description, path）
loadSkillContents(skills)      // → SkillContent[]（含 body, scripts）
formatSkillSummaries(skills)   // → 适合注入 LLM 的摘要字符串
formatSkillContents(contents)  // → XML 格式的完整内容
```

## 为什么这是问题

1. **Agent 无法主动使用 skill**：不知道有 `feishu-bot`、`ppio-web-search`、`set-cronjob` 等 skill 可用，除非用户明确提到
2. **依赖硬编码的 capability hint**：`round.ts` 中 `buildFeishuCapabilityContext` 硬编码了 `feishu-bot` skill 的引用路径（`workflows/skills/feishu-bot`），不可扩展，且路径与实际不一致（实际在 `shared/skills/`）
3. **新增 skill 对 Agent 不可见**：往 `shared/skills/` 添加新 skill 后，Agent 无法自动感知

## 相关代码

| 文件 | 位置 | 说明 |
|------|------|------|
| `apps/feishu/src/round.ts` | L68-98 | 上下文收集，缺少 skill 发现 |
| `apps/feishu/src/round.ts` | L44-52 | `buildFeishuCapabilityContext` 硬编码 skill 路径 |
| `apps/feishu/src/session.ts` | L211 | 只注入 skills 绝对路径字符串 |
| `packages/shared/src/skills/discovery.ts` | 全文件 | 已有完整的 skill 发现能力，未被飞书使用 |
