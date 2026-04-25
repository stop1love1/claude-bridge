# Claude Bridge — Cross-repo Coordinator

This project plays the role of **owner / coordinator** for a multi-repo system. It does not contain app code — it breaks work into tasks, decides per task which repo(s) to touch and how big an agent team to spawn, and keeps cross-repo context in sync.

Each app owns its own internal context (stack, architecture, conventions) in its own repo. The bridge only holds what **cannot be derived** from either app alone.

## Repos

Canonical declaration of the sibling app folders. Tools and AI agents read folder names from here. Paths are resolved as **siblings of this bridge folder** (`../<folder-name>`) — do not hardcode absolute paths. All entries are treated equally; the coordinator decides per task which to target based on the task body and the auto-derived `RepoProfile` (stack / features / entrypoints).

| Folder name |
|-------------|
| `app-web`   |
| `app-api`   |

> Replace the example rows with the real sibling folder names of your project. Add more rows as new apps join the system. Folder names must match real sibling directories. If a repo is renamed, update this table first, then propagate.

The bridge is **not code that ships into your app** — it's a thin layer of markdown files plus a Next.js UI used to distribute tasks, record contracts, log decisions, and track cross-repo bugs.

## Setup (for new developers)

The bridge is an independent git repository. Clone it **as a sibling** of your app repos (same parent folder):

```
<parent>/
├── app-web/
├── app-api/
└── claude-bridge/   ← clone here (folder name is up to you; this is the bridge root)
```

After cloning, edit the **Repos** table above so the folder names match your real siblings. The bridge auto-detects each sibling's stack/features by scanning its `package.json`, `prisma/schema.prisma`, top-level dirs, and CLAUDE.md / README.md — no further configuration is required.

The bridge is **optional**. If a sibling app's own CLAUDE.md guard checks for the bridge folder, it can detect its absence and skip bridge logic entirely — nothing breaks.

## When to read the bridge

Before starting any task with **cross-repo signals**:

- Touches an API (calling a new endpoint, changing request/response shape)
- Touches a schema or data model (entity, enum, field)
- The user mentions another repo ("repo-A returns the wrong field X", "repo-B needs endpoint Y")
- The user says "integrate", "connect", "sync" between repos

→ Read the active task list first (look for handoffs from another repo), then `decisions.md` (recent decisions that may affect this work).

## When to write to the bridge

After finishing a cross-repo task:

| Situation | Write to |
|---|---|
| Just shipped a new endpoint or changed a contract | `contracts/<feature>.md` + create a follow-up task for the consumer repo via the UI |
| Just migrated the DB / changed an entity / added an enum | `schema.md` (Recent migrations section) |
| Just locked in a decision that isn't obvious from the code (naming, format, pagination style…) | `bridge/decisions.md` (append, dated) |
| Need to ask another repo something before continuing | `bridge/questions.md` (OPEN section) |
| Found a bug whose root cause is in another repo | `bridge/bugs.md` (OPEN section) |

## File map

All bridge-runtime markdown lives under the `bridge/` folder. Top-level
`BRIDGE.md` and `README.md` are project-level docs.

| File | Purpose | Who writes | Frequency |
|---|---|---|---|
| `BRIDGE.md` | Index (this file) | Rarely changed | very low |
| `bridge/coordinator.md` | Coordinator prompt template | Bridge maintainers | very low |
| `bridge/report-template.md` | Child agent report contract | Bridge maintainers | very low |
| `bridge/tasks.md` | Legacy notebook — runtime data lives in `sessions/<id>/meta.json` | (none — bridge writes meta.json) | n/a |
| `bridge/schema.md` | Data model — entities, enums, migration log | Repo that owns the DB | low |
| `bridge/decisions.md` | Decisions log (append-only, dated) | Any repo | low |
| `bridge/questions.md` | Open questions between repos | Repo that asks | low |
| `bridge/bugs.md` | Cross-repo bugs | Repo that finds the bug | low |
| `contracts/<feature>.md` | API contract — request/response/errors | Repo that owns the endpoint | medium |
| `contracts/README.md` | Index of contracts | Updated when a new contract is added | low |
| `bridge.json` | Apps registry + bridge-level settings — declared by the UI's "Add app" / "Auto-detect" buttons | Bridge UI | low |

## Conventions

- **Plain markdown** — no JSON/YAML, so both humans and AI can read it.
- **Always date entries** with `YYYY-MM-DD`.
- **`bridge/decisions.md` is append-only.** To reverse an old decision, write a new entry that references the old one (`Supersedes: #YYYY-MM-DD-slug`).
- **Cross-link.** Link tasks → contracts / questions / decisions, using relative paths.
- **Don't dump everything.** The bridge holds only what **cannot be derived** from the source code or git history of any repo.
