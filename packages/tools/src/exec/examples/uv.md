### `uv` (via `uv run`): managed Python, no global install needed
```
import sys
print(f'Python {sys.version}')
```
**With libraries — use PEP 723 inline metadata (no separate install step):**
```
# /// script
# dependencies = ["requests"]
# ///
import requests
r = requests.get("https://api.github.com/repos/python/cpython")
print(r.json()["stargazers_count"], "stars")
```
