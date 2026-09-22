# ADR 0002 — Python backend, and how the doubled compiler is kept honest

**Status:** Accepted · 2026-09-22

## Context

The persistence layer was originally specified as Postgres + Prisma + Node, which
would have allowed a single shared TypeScript module (`layout-core`) to run in both
the browser and the API — one compiler, no duplication.

That was changed to **SQLAlchemy 2.0 + Alembic**, which means a **Python** backend.
The shared-module property is no longer available: TypeScript and Python cannot
share code.

The compiler must therefore exist twice, and the two copies must agree exactly.
Divergence would silently write wrong bin geometry into the database.

## Decision

Three safeguards, all mandatory:

1. **One canonical contract.** `packages/layout-core/schema/layout-doc.v1.json` is
   generated from the Zod source (`npm run gen:schema`) and committed. Python
   validates incoming documents against that same file with `jsonschema`. There is
   no hand-maintained Pydantic duplicate of the document schema.
2. **Shared conformance vectors.** `fixtures/layout-conformance/*.json` pair a
   document with expected bins, diagnostic codes and `docHash`. **Vitest and pytest
   run the identical files.** Either implementation drifting fails CI.
3. **A runtime drift alarm.** The client sends `clientDocHash`. If it disagrees with
   the server's, Publish returns `409 COMPILER_DRIFT` instead of writing.

The canonical hash is specified explicitly (§6): sorted keys, fixed-notation numbers
at 6 decimals, `-0` normalised, arrays ordered, sha256 of UTF-8.

Python is the **authoritative** compiler for database writes; TypeScript exists for
interactive latency. Where they disagree, Python wins — and the request is rejected
rather than silently resolved.

## Consequences

**Good**

- Raw SQL, migrations and analytics all work naturally; Alembic `downgrade()` and
  `alembic check` give real safety rails.
- The `docHash` fixture comparison is a genuine, byte-level proof of equivalence,
  not a smoke test.
- Validation stays honest: both sides run the same fixtures, so a rule cannot exist
  on only one side for long.

**Bad / accepted**

- **Every compiler change must be made twice, and the fixtures updated deliberately.**
  This is the main ongoing cost.
- A language boundary in the repo: contributors need both toolchains.
- `fixtures/` is the single most important directory in the repo and must not be
  weakened for convenience.

## Alternatives rejected

- **Server-side validation only** (client asks the API on every edit) — a network
  round trip per drag destroys the interactive editor.
- **Trust the client's compiled bins** — the DB becomes unverifiable; a client bug
  corrupts inventory data with no backstop.
- **Ship the TS compiler to Python via a sidecar Node process** — adds a runtime
  dependency and a failure mode, and still needs the fixtures.
