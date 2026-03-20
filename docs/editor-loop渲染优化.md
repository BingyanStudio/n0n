## 当前样式：

```md
▸ edit
  ├ intent
  │ 在 `await startCodeRepl(paths, initialInput);` 这一行之前，从 globalThis.__n0n_cli_opts 读取 resumeFile 和 saveEveryLoop 选项。然后把 startCodeRepl 的调用改为 `await startCodeRepl(paths, { initialInput, resumeFile, saveEveryLoop });`
  │ 
  │ 具体来说：
  │ 
  │ 1. 在 `const initialInput = ...` 之后，添加：
  │ ```ts
  │ const cliOpts = (globalThis as Record<string, unknown>).__n0n_cli_opts as
  │     | { resumeFile?: string; saveEveryLoop?: boolean }
  │     | undefined;
  │ const resumeFile = cliOpts?.resumeFile;
  │ const saveEveryLoop = cliOpts?.saveEveryLoop ?? false;
  │ ```
  │ ... (5 more lines)
  ├ path
  │ apps/code/src/index.ts
  ├──────────────────────────────
  │ [round 1]
  │   str_replace → edit #1
  │   str_replace → edit #2
  │ [round 2]
  │   view_file → ok
  │ [round 3]
  │   submit
◂ edit apps/code/src/index.ts 5.7s 3r +16 -10 ✓
```

它存在几个问题：
1. edit-loop replace str 的时候 replace 了什么？虽然 这里不适合展示 diff，但是可以提示替换结果，比如删除n行，添加n行
2. view-file 如果模型传递了参数，则应该展示参数内容（从 startline ～ endline）。以供外部更了解检查情况。
3. 最终submit 有一个 feedback，feedback 希望能够完整展示，以便于观察 edit 工具提供的反馈是否有用，以及反馈内容是否生效。