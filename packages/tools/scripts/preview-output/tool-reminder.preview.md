# Tool Definition: reminder
<!-- generated for model: claude-sonnet-4-20250514 -->

## parameters

```json
{
  "type": "object",
  "properties": {
    "content": {
      "type": "string",
      "description": "Reminder content: what you've done, what remains, and what to do next."
    },
    "estimate": {
      "description": "Rounds until this reminder fires (default: 7). 1 round = 1 tool call batch.",
      "type": "number"
    }
  },
  "required": [
    "content"
  ],
  "additionalProperties": false
}
```

## description

````
Set a memo for yourself (overwrites any previous — only one active at a time).
The content will appear as a `<reminder>` tag after the specified number of rounds.
Use it to track progress on multi-step tasks: what's done, what's next, what to watch out for.

This tool is deterministic and always succeeds — do not wait for its result.
````

## Full OpenAI function format

```json
{
  "type": "function",
  "function": {
    "name": "reminder",
    "description": "Set a memo for yourself (overwrites any previous — only one active at a time).\nThe content will appear as a `<reminder>` tag after the specified number of rounds.\nUse it to track progress on multi-step tasks: what's done, what's next, what to watch out for.\n\nThis tool is deterministic and always succeeds — do not wait for its result.",
    "parameters": {
      "type": "object",
      "properties": {
        "content": {
          "type": "string",
          "description": "Reminder content: what you've done, what remains, and what to do next."
        },
        "estimate": {
          "description": "Rounds until this reminder fires (default: 7). 1 round = 1 tool call batch.",
          "type": "number"
        }
      },
      "required": [
        "content"
      ],
      "additionalProperties": false
    }
  }
}
```
