---
name: ppio-web-search
description: Search the web for pages, images, and videos via PPIO Web Search API. Use when the user needs to find information online, get current news, or look up URLs. Returns structured results with titles, URLs, snippets, and optional summaries.
metadata:
  author: n0n
  version: "1.0"
---

# PPIO Web Search

## When to use this skill

Use this skill when the user needs to:
- Search the web for information, news, or references
- Find URLs or web pages about a specific topic
- Get current/recent information that may not be in training data
- Search within or exclude specific websites

## Configuration

API key is read from environment variable `WEB_SEARCH_API_KEY` (already configured in `.env`).

## Recommended: Import as library (preferred)

When creating workflow `.ts` files, **import the functions directly**:

```typescript
import { webSearch, searchWeb, searchWithSummary } from "../skills/ppio-web-search/scripts/lib.ts";

// Full search (returns webPages, images, videos)
const result = await webSearch({ query: "Bun runtime", count: 5, summary: true });
for (const page of result.webPages?.value ?? []) {
  console.log(page.name, page.url, page.summary);
}

// Quick web-only search
const pages = await searchWeb("TypeScript 5.0 features");

// Search with summaries enabled
const detailed = await searchWithSummary("AI news", { count: 5, freshness: "oneWeek" });
```

Exported functions from `scripts/lib.ts`:
- `webSearch(options)` → full search, returns `SearchResponse` with webPages/images/videos
- `searchWeb(query, options?)` → convenience, returns `WebPage[]`
- `searchWithSummary(query, options?)` → convenience, returns `WebPage[]` with summary field

### SearchOptions

| Parameter   | Type    | Required | Description                                          |
|-------------|---------|----------|------------------------------------------------------|
| `query`     | string  | Yes      | Search keywords                                      |
| `freshness` | string  | No       | Time range: `noLimit` (default), `oneDay`, `oneWeek`, `oneMonth`, `oneYear`, or `YYYY-MM-DD..YYYY-MM-DD` |
| `summary`   | boolean | No       | Return text summaries (default: false)               |
| `include`   | string  | No       | Limit to domains, separated by `\|`                  |
| `exclude`   | string  | No       | Exclude domains, separated by `\|`                   |
| `count`     | number  | No       | Number of results, 1-50 (default: 10)                |

## Alternative: CLI script

For quick one-off searches via `exec`:

```bash
bun run workflows/skills/ppio-web-search/scripts/search.ts "Bun runtime"
bun run workflows/skills/ppio-web-search/scripts/search.ts "AI news" --count=5 --summary --freshness=oneWeek
bun run workflows/skills/ppio-web-search/scripts/search.ts "TypeScript" --include=github.com|stackoverflow.com
```

### CLI options

| Flag              | Description                    |
|-------------------|--------------------------------|
| `--count=N`       | Number of results (1-50)       |
| `--summary`       | Enable text summaries          |
| `--freshness=VAL` | Time range filter              |
| `--include=DOMAIN`| Limit to specific domains      |
| `--exclude=DOMAIN`| Exclude specific domains       |

## Output format

CLI outputs JSON:

```json
{
  "query": "Bun runtime",
  "totalWebResults": 12345,
  "webPages": [
    {
      "name": "Bun — A fast all-in-one JavaScript runtime",
      "url": "https://bun.sh",
      "snippet": "Bun is a fast JavaScript runtime...",
      "summary": "Bun is an all-in-one toolkit for JavaScript and TypeScript apps...",
      "siteName": "bun.sh",
      "datePublished": "2025-01-15T10:00:00+08:00"
    }
  ],
  "images": [
    {
      "name": "Bun logo",
      "contentUrl": "https://example.com/bun.png",
      "hostPageUrl": "https://bun.sh",
      "width": 800,
      "height": 600
    }
  ]
}
```

## Tips

- Prefer `freshness: "noLimit"` (default) — the search algorithm auto-optimizes time ranges
- Use `summary: true` when you need detailed content understanding, not just snippets
- Use `include` to search within specific sites (e.g., `github.com|stackoverflow.com`)
