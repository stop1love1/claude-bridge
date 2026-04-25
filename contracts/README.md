# API Contracts

One file per endpoint group (by feature/domain). Each file documents endpoints with request/response/errors in a fixed format.

## Index

_(no contracts yet — add a row to the table below when you create a new file)_

| File | Domain | Status | Last update |
|---|---|---|---|
| _example_ | _example_ | _stable / draft / deprecated_ | _YYYY-MM-DD_ |

## When to create a new contract

- A new endpoint is shipped (BE writes the entry after merging)
- An existing endpoint changes shape (BE writes the entry **before** merging so FE knows)
- An endpoint is shared across multiple features → split it into its own file

## Contract file format

```md
# <Feature> API

## <METHOD> <path>
**Status:** stable | draft | deprecated (BE done YYYY-MM-DD)

**Request:**
\```json
{ "field": "type" }
\```

**Response 2xx:**
\```json
{ "field": "type" }
\```

**Errors:** 400 (...), 404 (...), 409 (...)

**FE usage:** `packages/api/functions/<file>.ts → <fnName>()`
**BE source:** `src/modules/<module>/<file>.controller.ts`
**Notes:** anything else (auth, rate limit, side effects)
```
