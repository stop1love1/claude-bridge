# Cross-repo Bugs

Bugs that one repo discovers but whose root cause lies in another (or that need multiple repos to coordinate to fix).

## OPEN

_(none)_

### Template

```md
### YYYY-MM-DD — <reporting-repo> → <owning-repo>: <short symptom>
**Repro:** specific steps (URL, payload, account, …)
**Expected:** per `contracts/<file>.md` or `decisions.md#<anchor>`
**Actual:** what happens instead
**Status:** new | confirmed | fixing | fixed-pending-verify
**Notes:** extra info (commit, PR, …)
```

## FIXED

_(none)_

### Template

```md
### YYYY-MM-DD — <symptom>
Fixed in `<repo-name>` commit `<sha>` / PR `<url>`. Verified by `<verifying-repo>`.
```
