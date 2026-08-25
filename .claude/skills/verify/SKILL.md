---
name: verify
description: Run the ordered local release gate, including packaged Bun and Node selfchecks, before pushing or releasing.
---

Run the release workflow's validation gate in order. Keep the two
`mock.module()` tests in their isolated process, matching CI:

```bash
bun run lint:all \
  && bun run typecheck \
  && bun test \
    --path-ignore-patterns='**/token-file-removal.test.ts' \
    --path-ignore-patterns='**/token-refresh-retry.test.ts' \
  && bun test tests/token-file-removal.test.ts tests/token-refresh-retry.test.ts \
  && bun run build \
  && bun run smoke:packaged
```

Report results clearly:
- If all steps pass, confirm success with a one-line summary.
- If any step fails, show the failure output and stop — do not continue to later steps.
