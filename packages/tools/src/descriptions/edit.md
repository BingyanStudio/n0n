Edit a file using Vim ex commands. The file must already exist.
Commands are executed in neovim headless mode via a sourced script.
Write commands as a multi-line string — each line is one ex command or content line.
Use standard Vim ex syntax — `:s`, `:c`, `:d`, `:a`, `:i`, `:g`, etc.

**Example 1 — Replace a function body:**
```
/function validateToken/+1,/^}/-1c
  const decoded = jwt.verify(token);
  if (!decoded) throw new Error('invalid');
  return decoded.userId;
.
```
Addressing: `/pattern/+1` = line after match, `/^}/-1` = line before `}`.
The `:c` (change) command replaces the addressed range with new content.
A single `.` on its own line terminates the input.

**Example 2 — Replace a markdown section:**
```
/## Installation/+1,/^##/-1c
Run `npm install` to get started.

See [docs](./docs) for details.
.
```

**Example 3 — Append content after a line:**
```
/import.*react/a
import { useState } from 'react';
.
```

**Example 4 — Delete and global commands:**
```
g/console\.log/d
```
Deletes all lines containing `console.log`.

**Example 5 — Single-line substitution (vim `:s` command):**
```
%s/return 'error'/return Result.err('validation failed')/
```
Note: `:s/old/new/` must be a **single line**. Do NOT split search and replace across lines.

**Quick reference:**
  3d                 — delete line 3
  2,4d               — delete lines 2-4
  %s/old/new/g       — global search & replace
  /pattern/d         — delete line matching pattern
  /start/,/end/d     — delete range between patterns
  g/pattern/d        — delete ALL lines matching pattern

**Important:**
- Do NOT include `:wq` — it is added automatically.
- `:c`, `:a`, `:i` commands MUST end with a single `.` on its own line.
- Content lines inside `:c`/`:a`/`:i` must NOT be a lone `.` (it terminates input).
  If you need a literal `.` line, use `..` or a workaround.
- Multiple `/pattern/+offset,/pattern/-offset c` (offset-addressed change) commands
  in one call will silently fail after the first.
  **Workaround**: use `/start/,/end/c` without offsets (include boundary lines in
  replacement content), use absolute line numbers (edit bottom-to-top), or split
  into separate edit() calls.
- Pattern addresses match the **first** occurrence from the current position.
  When a file has similar/repeated patterns (e.g. multiple functions with `}`),
  include enough context in your pattern to ensure a unique match.
  For example, use `/function specificName/` instead of just `/function/`.
- **Edits are atomic**: if ANY command fails or is skipped (e.g. pattern not found),
  the entire edit is rolled back. Fix all patterns and retry.
