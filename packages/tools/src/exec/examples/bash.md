- `bash`: advanced shell scripting (arrays, process substitution)
  `for f in src/*.ts; do echo "$(wc -l < "$f") $f"; done | sort -rn | head -5`
