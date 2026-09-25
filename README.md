# warehouse-3d

A 3D warehouse designer with an operator view. You design the physical layout — footprint,
aisles, rack runs, levels, gaps — and the system compiles it into bins, publishes it, and
renders the same layout for operations with live inventory in it.

## The one idea worth knowing

The layout compiler is implemented **twice**: once in TypeScript (`packages/layout-core`,
which the editor runs in the browser) and once in Python (`server/app/layout`, which the API
runs before it writes anything). They are kept honest by two mechanisms:

- shared **conformance fixtures** (`fixtures/`) that both test suites run, so a divergence
  fails a test rather than reaching a database;
- a **canonical document hash**, computed identically on both sides. Publishing sends the
  client's hash, and a mismatch is refused as `COMPILER_DRIFT`.

The tradeoff is real: every compiler change is written twice. It buys a browser that can
validate a layout interactively, and a server that can refuse to store something it does not
agree about. `docs/adr/0002-python-backend-and-conformance-vectors.md` records the decision;
§14 of the plan records the cost.

## Getting started

```bash
npm install
npm run db:up          # Postgres 16 on :5433, via Docker
npm run api:migrate    # alembic upgrade head
npm run dev            # the app on :5173
npm run api:dev        # the API on :8000 (in another terminal)
```

The editor works with no server at all — it is local-first. Connect from the toolbar to save
drafts and publish.

Note: port 8000 is already used by some Docker setups. If the API cannot bind, run it
elsewhere and point the app at it:

```bash
cd server && uv run uvicorn app.main:app --port 8001
VITE_API_URL=http://127.0.0.1:8001 npm run dev
```

### Try it with something realistic

```bash
npm run seed                 # 12 aisles, 1440 bins, 7 SKUs, ~860 placements
npm run seed -- --aisles 40  # 4800 bins, if you want to see it work at size
```

## The two modes

**Design** authors the layout. Aisles are dragged in 3D; everything numeric is editable in
the inspector, which is authoritative — if a drag and a typed value disagree, the typed value
wins. Diagnostics are computed by the compiler as you type, and publishing is blocked while
any error remains.

**Operate** reads a layout and shows its inventory: which bins hold what, how full they are,
and what has not moved in a month. It shows the **published** version when a warehouse is
open and the working copy otherwise, and says which one you are looking at.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm test` | layout-core suite (compiler, commands, store, conformance) |
| `npm run test:app` | editor, persistence and operate suites, including the performance budgets |
| `npm run test:e2e` | Playwright journeys in a real browser (needs `npm run test:e2e:install` once) |
| `npm run test:py` | Python API suite, including cross-language conformance |
| `npm run verify` | everything: typecheck, both suites, both linters, migration cycle |
| `npm run gen:schema` | regenerate the JSON Schema and rule codes from the registry |
| `npm run gen:hashes` | refill fixture expectations — **review the diff** |
| `npm run gen:api-types` | regenerate the client's API types from the FastAPI schema |
| `npm run seed` | create a demo warehouse |

Three app test files (`drift`, `placement`, `operate.integration`) talk to a running API and
**skip themselves** when there is none, so `test:app` works on a machine with only the
frontend up. With the API running they close the loop between the two compilers over a real
socket — which is the only way to catch a divergence that the fixtures do not cover.

`test:e2e` is deliberately **not** part of `verify`: it downloads a browser and starts a dev
server, which is slow and environment-sensitive enough that folding it in would make `verify`
the thing people stop running. It starts its own server on port 5180, so a dev server you
already have running is left alone.

The core suite also holds **performance budgets** — one linear-time pass over 100k bins, and
a plan view whose work is bounded by aisle count rather than bay count. They assert
algorithmic properties rather than frame timings, because frame timings depend on the GPU and
would fail on someone else's machine.

## Layout

```
packages/layout-core/       pure TS core: schema, compiler, rules, commands, history
server/app/layout/          the Python mirror, file for file
server/app/                 API, models, services (draft, publish, inventory)
fixtures/                   the contract: documents both implementations must agree on
src/design/                 3D authoring: canvas, inspector, panels
src/design/persistence/     API client, session, autosave, inventory
src/operate/                the operator view
docs/                       the plan, the operator manual, and the ADRs
```

## Documentation

- `docs/warehouse-designer-plan.md` — the design, the phased plan, and what each phase cost.
  §13 is the build log, including the bugs found along the way.
- `docs/operator-manual.md` — for people operating a warehouse rather than designing one.
- `docs/adr/` — the decisions that are expensive to reverse.

## Non-goals

Not a WMS. No multi-tenant orgs, SSO or RBAC in v1 (a `tenant_id` seam exists), no CAD
import, no sloped floors or mezzanines, and no automated slotting. Arbitrary-angle rack
rotation is out too: v1 is axis-aligned, which is what the compiler's geometry assumes.
