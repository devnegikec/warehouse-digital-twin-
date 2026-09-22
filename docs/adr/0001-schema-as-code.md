# ADR 0001 — Schema is code; the designer writes rows

**Status:** Accepted · 2026-09-22

## Context

The original brief said the warehouse design "will be used for Backend to create
tables". Read literally, that means generating DDL per warehouse — a table per
customer layout, or columns derived from user input.

## Decision

**Tables come from Alembic migrations, reviewed and versioned in git. The designer
writes rows, never schema.**

- Structure lives in `warehouse`, `layout_version`, `aisle`, `lane`, `bay`, `bin`.
- Per-customer variation goes in `metadata JSONB` columns, which already exist on
  every entity.
- A published layout is a row in `layout_version` plus materialised structure rows,
  written in one transaction.

## Consequences

**Good**

- Query planning, indexes, referential integrity and ORM tooling all keep working.
- Migrations are reviewable artefacts with tested `downgrade()` paths.
- Multi-tenancy stays a feature flag rather than a schema-shape decision.
- The DB can answer relational questions ("which bins hold SKU X in aisle A?")
  with an index instead of a JSON scan.

**Bad / accepted**

- Custom per-customer *structural* variation needs a migration. If a customer needs
  a genuinely new structural concept, that is a product decision, not a runtime one.
- `metadata JSONB` is schemaless, so its contents are unvalidated by the database.
  Validate at the API boundary instead.

## Alternatives rejected

- **Dynamic DDL per warehouse** — breaks migrations, indexes, ORM tooling and
  multi-tenancy. Catastrophic at the first upgrade.
- **Entity-Attribute-Value table** — trades all relational guarantees for
  flexibility nobody asked for.
- **One wide table per customer** — same problems as dynamic DDL, plus connection
  routing complexity.
