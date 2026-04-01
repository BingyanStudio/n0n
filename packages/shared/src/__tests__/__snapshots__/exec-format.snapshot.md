# exec formatPrompt snapshot
# model: claude-sonnet-4-20250514
# generated: 2026-04-01T17:48:06.590Z

## completed (success)

```
<exec_meta>
[sh] [cwd: src] [exit: 0] [12ms]
</exec_meta>
<stdout>
hello
total 16
drwxr-xr-x  4 user staff  128 Jan  1 00:00 .
drwxr-xr-x  8 user staff  256 Jan  1 00:00 ..
</stdout>
```

## completed (error)

```
<exec_meta>
[unknown] [cwd: .] [exit: 1] [5ms]
</exec_meta>
<stderr>
cat: missing.txt: No such file or directory
</stderr>
```

## truncated

```
<exec_meta>
[sh] [cwd: .] [exit: 0] [320ms] [output truncated → .temp/exec_output_call_3_1775063000000.txt]
</exec_meta>
<stdout>
... (last 141 of 28450 chars)
./packages/tools/src/exec/executor.ts
./packages/tools/src/exec/security.ts
./packages/tools/src/exec/index.ts
./packages/types/src/domain.ts
</stdout>
<output_hint>
Full output (28450 chars) written to: .temp/exec_output_call_3_1775063000000.txt
Use exec to read specific parts: cat, grep, sed, head, tail, or bun script.
</output_hint>
```

## timed_out

```
<exec_meta>
[unknown] [cwd: .] [timed out after 30003ms]
</exec_meta>
<timeout_notice>
Process exceeded timeout, moved to background.
PID: 65432
Log file: .temp/exec_bg_65432_1775062634766.log
Read the log file later to check process status.
</timeout_notice>
<stdout>
npm warn deprecated inflight@1.0.6
added 142 packages in 28s
</stdout>
```
