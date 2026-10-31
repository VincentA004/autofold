# Verify saved links with native bash

Run this command through Pi's existing bash tool. Supply an absolute root and the
Markdown files being relied on, relative to that root. Always use the campaign
root for new-layout records, including trial plan.md and assessment.md. Select
relevant investigation and handoff files too. Check frozen earlier trials without
rewriting them; report missing evidence. Older context snapshots may be checked
with their explicit context root according to their recorded convention.

This checks the contract's inline `[label](relative-path)` links (angle brackets for
spaces). It skips HTTP/mail links and code examples, rejects reference-style links
and paths escaping the selected root, and exits nonzero for missing targets. It
does not fetch URLs, crawl dependencies, verify heading anchors or judge evidence.
Select the relied-on documents explicitly; counts show what was actually checked.

```sh
python3 - /absolute/campaign/root notebook/index.md notebook/investigations/example.md <<'PY'
import json
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit

if len(sys.argv) < 3:
    raise SystemExit('Supply a root and at least one Markdown file')
root = Path(sys.argv[1]).resolve()
if not root.is_dir():
    raise SystemExit('Root must be an existing directory')
errors = []
checked = fragments = files = 0
pattern = re.compile(r'\[[^\]\n]*\]\((<[^>\n]+>|[^\s()]+)\)')
for name in sys.argv[2:]:
    document = (root / name).resolve()
    if not document.is_relative_to(root) or not document.is_file():
        errors.append({'file': name, 'error': 'missing document or outside root'})
        continue
    files += 1
    fence = None
    for number, line in enumerate(document.read_text(encoding='utf-8').splitlines(), 1):
        marker = re.match(r'^\s*(`{3,}|~{3,})', line)
        if marker:
            token = marker.group(1)
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence):
                fence = None
            continue
        if fence is not None:
            continue
        line = re.sub(r'(`+).*?\1', '', line)
        matches = list(pattern.finditer(line))
        if (line.count('](') != len(matches)
                or re.search(r'\[[^\]]+\]\[[^\]]*\]|^\s*\[[^\]]+\]:', line)):
            errors.append({'file': name, 'line': number, 'error': 'unsupported link syntax'})
        for match in matches:
            target = match.group(1).strip('<>')
            parts = urlsplit(target)
            if parts.scheme in ('http', 'https', 'mailto'):
                continue
            if parts.scheme or parts.netloc or parts.query or Path(parts.path).is_absolute():
                errors.append({'file': name, 'line': number, 'target': target,
                               'error': 'use a relative file link'})
                continue
            fragments += bool(parts.fragment)
            if not parts.path:
                continue
            checked += 1
            path = (document.parent / unquote(parts.path)).resolve()
            if not path.is_relative_to(root) or not path.exists():
                errors.append({'file': name, 'line': number, 'target': target,
                               'error': 'missing target or outside root'})
print(json.dumps({'files': files, 'local_links': checked,
                  'fragments_not_verified': fragments, 'errors': errors}, indent=2))
raise SystemExit(1 if errors else 0)
PY
```
