# Prompt Design Principles

## Core Philosophy: Test-Driven Deep Thinking

### From "Instruction Following" to "Exam Taking"

The fundamental problem with traditional prompt engineering: the model is positioned as an **instruction follower** — it waits for your guidance, acts by your rules, thinks within your framework. This leads to:

1. **Passivity** — The model waits for instructions, doesn't proactively explore
2. **Shallow reasoning** — Following rules is easier than solving problems
3. **Premature abandonment** — "The rules don't cover this case" becomes an excuse to give up

### The Solution: Build Scoring Scenarios

Reframe the interaction as a **testing scenario**: the model isn't "completing a task," it's "taking an exam with a standard answer."

> **Background**: A skilled engineer has already completed this task — clean code, tested, production-ready. The implementation exists but is hidden from you. Your job is to **reason out what the engineer wrote**, step by step, and reconstruct it.
>
> You are not creating something new. You are deducing what already exists.
>
> **Evaluation Mechanism**: Your submission will be scored against the hidden reference implementation. The engineer never said "I can't do this" — they used tools, tried multiple approaches, and delivered working code. Your score depends on how closely your reasoning matches theirs.
>
> **Passing Criteria**: There is no request that "cannot be done." Only after 3 genuine, distinct attempts with evidence of failure may you submit an error.

### Why Scoring Scenarios Work

| Mechanism | Psychological Effect | Behavioral Outcome |
|-----------|---------------------|-------------------|
| **Reference answer exists** | Problem must have a solution | Eliminates "can't do it" shortcuts |
| **Step-by-step scoring** | Every decision is evaluated | Deep reasoning at each choice point |
| **Attempt requirements** | Giving up has a cost | Persistent attempts of multiple methods |
| **Evidence requirements** | Laziness will be detected | Document complete attempt process |

**Core Insight**: The scoring rubric itself is behavioral guidance. You don't need to tell the model "think deeply" — you only need to make it believe "deep thinking earns points, shallow attempts lose points."

---

## Scoring Rubric: Agency Level Assessment

Quantify desired behaviors into concrete scoring levels to make evaluation actionable.

### Agency Level Comparison Table

| Scenario | Passive Behavior (3.25 pts) | Active Behavior (3.75 pts) |
|----------|---------------------------|--------------------------|
| **Encountering errors** | Only look at the error itself | Check 50+ lines of context + search similar issues + check hidden related errors |
| **Fixing bugs** | Stop after fixing | Check for similar bugs in same file, same patterns in other files |
| **Insufficient information** | Ask user "please tell me X" | Self-check with tools first, only ask what truly needs confirmation |
| **Task completion** | Say "done" | Verify results + check edge cases + report potential risks |
| **Debugging failure** | "I tried A and B, doesn't work" | "I tried A/B/C/D/E, ruled out X/Y/Z, narrowed down to W" |

### Scoring Application Examples

```ts
// ❌ 3.25 pts approach: Passive response
User: "This file errors when running"
exec({ script: "bun run src/index.ts" })
// After seeing error, return directly
submit({ type: "chat", message: "Error: xxx, please fix." })

// ✅ 3.75 pts approach: Active exploration
User: "This file errors when running"
// 1. Reproduce error
exec({ script: "bun run src/index.ts 2>&1" })
// 2. Check context
exec({ script: "type src/index.ts" })
// 3. Search similar issues
exec({ script: "findstr /C:\"error message\" src\\*.ts" })
// 4. Check related files
exec({ script: "type package.json | findstr dependencies" })
submit({ 
  type: "completed", 
  report: "Error cause: xxx. Checked: 1) 50 lines of error context 2) 3 similar issues 3) dependency version conflict. Fix: ..." 
})
```

---

## Debugging Methodology: Five-Step Process

Derived from "Alibaba Three Axes" (smell, pull hair, look in mirror), expanded to a scorable 5-step flow.

### Five-Step Flow

| Step | Core Actions | Scoring Points |
|------|-------------|----------------|
| **1. Smell** | List all attempts, find common failure patterns | Did they systematically review attempted methods? |
| **2. Pull Hair** | Read error word-by-word → WebSearch → read source → verify environment → invert assumptions | Did they dig for root causes? |
| **3. Look in Mirror** | Repeating? Searched? Read? Checked simplest possibilities? | Did they reflect on their approach? |
| **4. Execute** | New approach must be fundamentally different, with verification criteria, produces new info on failure | Does new attempt have information gain? |
| **5. Review** | What was solved? Why didn't I think of this before? Then proactively check related issues | Did they proactively expand the check scope? |

### Scoring Criteria for Debugging Process

**3.25 pts debugging log**:
> "I tried A and B, neither works. May need more info from user."

**3.75 pts debugging log**:
> "I tried five methods A/B/C/D/E:
> - A (restart service): Failed, error unchanged → ruled out temporary state issue
> - B (check dependencies): Versions normal → ruled out dependency conflict
> - C (read source lines 50-80): Found possible null pointer → but adding null check still failed
> - D (WebSearch similar issues): Found 3 cases, 2 were config issues → checked config, normal
> - E (invert assumption: not A problem but B problem): Verified and found B's config was indeed missing
> 
> Resolved. Additional checks: other config items in same file, similar config patterns in other files, all normal."

---

## Prompt Structure: The Vehicle for Scoring Scenarios

The final structure follows a five-part pattern, each serving the scoring scenario:

```
Background    → Set the exam scene: reference answer exists, you're being scored
Tools         → Provide answer tools: show tool signatures and usage demos
Constraints   → Exam rules: simple safety boundaries (no sudo, etc.)
Specification → Scoring criteria: technical specs are scoring points (including agency levels)
Examples      → Sample problems: <good_example> scoring approach / <bad_example> penalty approach
```

### Example: Wrapping User Input as "Problem Clues"

User input is no longer "instructions" but **clues about the reference answer**:

```markdown
<hint>
User's original words
</hint>

First, ask yourself: can I answer this by calling `exec`, `write`, or `edit`? If yes — do it, then submit as `completed`.
If this is a pure social greeting with nothing actionable (e.g., 你好，谢谢), submit a `chat` response.
Otherwise, the engineer has already built the perfect workflow for this.
Reason out what it looks like — start by calling `reminder` with your OKR breakdown,
then proceed step by step.
```

**Design Intent**:
- `<hint>` tag implies "this is a clue, not a command"
- Behavioral guidance ordered "tool-solvable → pure social → workflow reasoning" to prioritize attempts
- "Engineer has already built" reinforces the "answer exists" belief

---

## Scoring Rubric Design: Translate Desired Behaviors into Scoring Points

### Core Principle

**Don't tell the model what to do; make it believe doing so will earn points.**

| Desired Behavior | Scoring Rubric Design | Psychological Mechanism |
|-----------------|----------------------|------------------------|
| Deep thinking | "Every step is compared to reference implementation" | Continuous evaluation pressure |
| Persistent attempts | "Can only give up after 3 distinct attempts" | Increased cost of abandonment |
| Tool-first | "Submit completed directly when tools can solve" | Clear scoring path |
| Active exploration | "Agency 3.75: self-check before asking" | Quantified evaluation criteria |
| Systematic debugging | "Complete five-step log earns high scores" | Methodology is scorable |
| Document process | "Submitting error requires failure evidence" | Laziness will be detected |

### Submit Types: Scoring Channels

Narrow each type's definition to make it a natural outcome of scoring:

| Type | Scoring Condition | Penalty Scenario |
|------|------------------|-----------------|
| `completed` | Tool call succeeds or problem solved | Choosing chat when tools could solve |
| `chat` | **Only** pure social greetings (你好，谢谢) | Treating executable requests as chat |
| `error` | 3 distinct attempts + complete evidence (five-step log) | Giving up without sufficient attempts |
| `need_info` | Genuinely multiple valid interpretations, and self-checked | Requesting clarification without trying to understand |

**Example Contrast**:

```ts
// ❌ Penalty approach: Giving up without trying
User: "现在几点？" (What time is it?)
submit({ type: "chat", message: "I'm an automation assistant and can't get local time." })
// Scoring: Could have exec("date"), chose chat path → penalty

// ✅ Scoring approach: Attempt the obvious solution
User: "现在几点？" (What time is it?)
exec({ script: "date" })
submit({ type: "completed", result: "当前时间是 2026-03-07 15:00:00 CST" })
// Scoring: Identified tool-solvable scenario, solved directly → points earned
```

---

## Tool Design: Semantic Clarity for Answer Tools

### Separation Principle

Each tool has a single responsibility; field names explain usage:

| Tool | Parameters | Purpose |
|------|------------|---------|
| `write` | `path, content` | Create/overwrite files |
| `edit` | `path, search, replace, expectedMatches?` | Precisely modify existing content |
| `exec` | `script, runtime?, cwd?, timeout?` | Execute scripts in specified runtime |

**Anti-pattern**: One tool with multiple semantics (e.g., `write` using optional `search` to distinguish create/modify)

### Programmatic Tool Calling: Efficient Answer Strategy

Guide models to orchestrate tools through code, not multiple API round-trips:

```ts
// ❌ Inefficient: Multiple round-trips, context pollution
exec({ script: "dir /b src" })
exec({ script: "type package.json" })
exec({ script: "findstr version" })

// ✅ Efficient: Single script, process internally
exec({ runtime: "bun", script: `
import { readdir, readFile } from 'node:fs/promises';
const files = await readdir("./src");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
console.log({ files: files.length, version: pkg.version });
`})
```

**Scoring Guidance**: Explicitly state best practices in tool descriptions — "process output inside the script, only print needed summaries." This makes the efficient approach the natural choice for those who "know scoring techniques."

### Script + Runtime Model

```ts
exec({ script: "git status" })                              // Default shell
exec({ script: "Get-Process | Where-Object ...", runtime: "pwsh" })  // PowerShell
exec({ script: "const x = await fetch(...)", runtime: "bun" })       // TypeScript
```

**Implementation**: All platforms write to temp file then execute, eliminating shell quoting issues.

---

## Context Organization: Structured Presentation of Scoring Feedback

### XML + Markdown Hybrid Structure

Use XML tags to mark content boundaries, with Markdown for rich expression inside:

```xml
<exec_meta>
[bun] [cwd: .] [exit: 0] [109ms]
</exec_meta>
<stdout>
=== Found 32 docs/MD files ===
📁 docs/skills
📄 docs/prompt-design-principles.md (9629B)
</stdout>
<error>
**Error**: File not found
</error>
```

**Design Principles**:
1. XML tags as boundary markers only — no escaping needed
2. Free Markdown usage inside tags (`**bold**`, `` `code` ``, lists)
3. All tags generated via `wrapTag()`, auto-adapting to model styles

### Model-Specific Tag Styles

| Model Family | Open Tag | Close Tag |
|--------------|----------|-----------|
| Deepseek | `<\|DSML\|tag>` | `<\|/DSML\|tag>` |
| GLM | `<tag>` | `</tag>` |
| Minimax | `]~b]tag` | `[e~[` |
| Default | `<tag>` | `</tag>` |

**Implementation**: Templates use standard XML; runtime adapter converts to model-native styles.

---

## Best Practices: High-Scoring Answer Strategies

### 1. Process Output Inside Scripts

```ts
// ❌ Inefficient: Raw data pollutes context
exec({ script: "find . -name '*.ts' -exec wc -l {} +" })

// ✅ Efficient: Summarize inside script, return only results
exec({ runtime: "bun", script: `
import { readdir, readFile } from 'node:fs/promises';
const files: {path: string, lines: number}[] = [];
// ... walk and count ...
files.sort((a, b) => b.lines - a.lines);
console.log('Total:', files.length, 'files');
console.log('Top 5:');
for (const f of files.slice(0, 5)) console.log(' ', f.lines, f.path);
`})
```

### 2. Read Before Modifying

```ts
// Explore structure
exec({ script: "find src -name '*.ts' | head -20" })
exec({ script: "cat src/index.ts" })

// Implement
write({ path: "src/utils.ts", content: "..." })

// Verify
exec({ script: "bun run tsc --noEmit" })
exec({ script: "bun test" })
```

### 3. Use Reminder for Multi-Step Tasks

```ts
reminder({
  content: `
**Objective:** Create phased summary document

**Key Results:**
- [ ] Explore docs folder structure
- [ ] Read and analyze documentation
- [ ] Extract core principles and examples
- [ ] Write clean summary document

**Current Progress:** Starting
**Next Step:** Explore docs folder
`
})
```

### 4. Apply Five-Step Debugging Method

```ts
// 1. Smell: List attempted methods
// 2. Pull Hair: Deep investigation
exec({ script: "type src/index.ts" })  // Read source
exec({ script: "findstr /C:\"error\" src\\*.ts" })  // Search similar
// 3. Look in Mirror: Reflect on approach
// 4. Execute: New approach
exec({ script: "bun run --inspect src/index.ts" })  // Debug mode
// 5. Review: Check related after resolution
exec({ script: "findstr /C:\"similar pattern\" src\\*.ts" })
```

---

## Iteration → Scoring Rule Mapping

This document's design comes from iterative scoring scenario optimization:

| Iteration Problem | Scoring Rule Design | Behavioral Change |
|------------------|--------------------|------------------|
| Model too easily says "can't do" | "3 distinct attempts + evidence required for error" | Persistent attempts of multiple methods |
| Chat instead of tool use | "Submit completed when tools can solve; chat loses points" | Prioritize tool calls |
| Raw output pollutes context | "Process output inside scripts" as best practice | Efficient data summarization |
| Confusing write/edit semantics | Split into separate tools; field names explain usage | Intuitive tool understanding |
| Cross-model tag incompatibility | Adapter layer for unified conversion | Template readability + model compatibility |
| Passive error response | "Agency 3.75: check context + search + related checks" | Proactively explore root causes |
| Scattered debugging methods | "Five-step method" as standard scoring framework | Systematic debugging flow |

---

## Psychological Foundations of Scoring Scenarios

### 1. External Evaluation Pressure

When the model believes "every step is scored," it:
- Thinks "What would the reference implementation do?" at each decision point
- Excludes shallow shortcuts (they lose points)
- Proactively explores multiple methods (attempt count affects score)

### 2. Belief in Answer Existence

The "reference answer exists" belief eliminates:
- Self-persuasion that "this problem has no solution"
- Excuses like "the rules don't cover this case"
- Identity limitations like "I'm not built for this"

### 3. Clarity of Scoring Paths

Clear scoring rubrics let the model know:
- What behaviors earn points (tool-first, deep reasoning, active exploration)
- What behaviors lose points (premature abandonment, context pollution, passive response)
- How to maximize scores (five-step logs, agency 3.75 behaviors)

---

## Conclusion: Scoring Is Guidance

**Core Insight**: You don't need to tell the model "think deeply." You only need to build a scoring scenario where deep thinking is the rational choice for earning points.

The essence of the entire prompt system is **scoring rule design**:

| Component | Scoring Function |
|-----------|-----------------|
| Background | Set the "exam with reference answer" scene |
| Tools | Provide answer tools, demonstrate efficient usage |
| Constraints | Define exam boundaries (safety rules) |
| Specification | Clarify technical specs as scoring points (including agency levels, five-step method) |
| Examples | Show scoring vs penalty approaches |
| Submit Types | Scoring channels with narrowed definitions to prevent abuse |

When the model believes "deep thinking earns points, shallow attempts lose points," deep reasoning becomes a rational choice, not an external mandate.

This is test-driven deep thinking: **the scoring rubric is the behavioral guidance**.
