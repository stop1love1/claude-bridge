# Schema — Data Model

Important entities and enums shared across repos. When the owning repo migrates, append to "Recent migrations".

> Do **not** copy the entire DB schema here — only the entities and fields that consumer repos need to know about (to render UI or call APIs).

## Entities

_(none yet — add an entry when multiple repos need to align on an entity)_

### Template

```md
### Entity: <Name>
- id (uuid)
- field1 (type) — describe if not self-explanatory
- field2 (Enum<Name>)
- relation: belongs to <Other> via <fk>

**Owner repo:** `<repo-name>` (the side that defines the schema)
**Consumer repos:** `<repo-name>`, … (any side that reads / renders this entity)
```

## Enums

_(none yet)_

### Template

```md
### Enum: <Name>
- VALUE_A — describe
- VALUE_B — describe
```

## Recent migrations

> Format: `YYYY-MM-DD: short description (entities affected, migration file if any)`. The owner repo writes the entry after merging the migration. Consumer repos read it to know when to update types.

_(none yet)_
