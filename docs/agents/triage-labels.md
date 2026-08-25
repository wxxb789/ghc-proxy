# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

The table defines the desired vocabulary; it is not an installation inventory.
Check the tracker before use because label state can change:

```bash
gh label list --limit 200 --json name --jq '.[].name'
```

Create missing labels only after explicit authorization and a fresh inventory.

When a skill mentions a role, use the mapped string only if it exists. Otherwise
record the role in the issue body and do not silently substitute another label.

Edit the right-hand column to match whatever vocabulary you actually use.
