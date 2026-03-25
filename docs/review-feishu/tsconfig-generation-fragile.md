# tsconfig.json 生成逻辑在自定义路径下失效

## 严重程度：中

## 问题描述

`paths.ts` 中为用户 workspace 自动生成 `tsconfig.json` 的逻辑，硬编码了项目根目录的推算方式 (`resolve(FEISHU_BASE, "..", "..")`)，当使用 `N0N_FEISHU_WORKSPACE` 环境变量自定义工作区路径时，生成的 `extends` 路径指向错误位置。

## 问题代码

### `apps/feishu/src/paths.ts`

```typescript
const FEISHU_BASE = resolve(
    process.env.N0N_FEISHU_WORKSPACE ??
        resolve(process.cwd(), ".runtime", "feishu"),
);

// ...
const tsconfigPath = resolve(workspace, "tsconfig.json");
if (!existsSync(tsconfigPath)) {
    const projectRoot = resolve(FEISHU_BASE, "..", "..");  // ← 假设固定层级
    const tsconfig = JSON.stringify(
        { extends: resolve(projectRoot, "tsconfig.json") },
        null,
        "\t",
    );
    writeFileSync(tsconfigPath, tsconfig);
}
```

### 默认场景（正确）

```
FEISHU_BASE = <cwd>/.runtime/feishu
projectRoot = resolve(<cwd>/.runtime/feishu, "../..") = <cwd>  ✅
tsconfig extends: <cwd>/tsconfig.json  ✅
```

### 自定义路径场景（错误）

```
N0N_FEISHU_WORKSPACE=/data/feishu-workspaces
FEISHU_BASE = /data/feishu-workspaces
projectRoot = resolve(/data/feishu-workspaces, "../..") = /  ❌
tsconfig extends: /tsconfig.json  ❌  (不存在)
```

## 影响

- 使用 `N0N_FEISHU_WORKSPACE` 环境变量时，workflow 脚本的 `@n0n/*` 模块导入失败
- 生成的 tsconfig.json 指向不存在的文件，bun 执行时报错

## 建议修复

1. 将项目根目录通过独立环境变量（如 `N0N_PROJECT_ROOT`）或编译时常量传入，不依赖相对路径推算
2. 或者在生成 tsconfig 前验证 `projectRoot/tsconfig.json` 存在，不存在时生成完整的 paths 配置而非 extends

## 相关文件

| 文件 | 说明 |
|------|------|
| `apps/feishu/src/paths.ts` | tsconfig 生成逻辑 |
| `tsconfig.json` (项目根) | 包含 `@n0n/*` 路径映射 |
