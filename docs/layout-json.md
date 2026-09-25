# Authoring a layout as JSON

The layout document **is** the input format. There is no separate import schema and no
translation layer: what the editor holds, what the API stores and what you can hand-write
are the same object. The contract is
`packages/layout-core/schema/layout-doc.v1.json`, generated from the Zod schema in
`packages/layout-core/src/schema.ts` — so the JSON Schema and the runtime validator cannot
disagree.

Load a file with **Import…** in the toolbar (file picker or paste). The import is a normal
command, so a bad file changes nothing and a good one is a single undo away.

Three worked examples live in `examples/designs/`, and `src/design/examples.test.ts` keeps
them honest — each must compile with **zero** diagnostics.

| File | What it demonstrates |
|---|---|
| `01-cross-aisle-two-way.json` | 3 aisles × 2 lanes × 10 bays × 5 levels, with a 2-bay cross-aisle cutting every lane in half. Columns, a pillar, an office. |
| `02-vertical-one-way-doorways.json` | Aisles along Z, one-way travel, a doorway gap at the end of a lane, a reserved bay, inset runs (`startOffsetM`), two rack types, a custom `binCodePattern`, a wall. |
| `03-high-bay-freezer-deep.json` | 12 m building, 7 levels, double-deep 2.2 m lanes, **two** cross-aisles splitting every lane into thirds, conveyor (CUSTOM obstacle), frozen metadata. |

Try one:

```bash
# paste into the Import dialog, or from the browser console:
#   __designStore.getState().dispatch({ type: 'document.replace', doc: <parsed> })
cat examples/designs/01-cross-aisle-two-way.json
```

## Top-level

```jsonc
{
  "schemaVersion": 1,          // required, exactly 1
  "warehouse": { … },          // required
  "rackTypes": [ … ],          // default []
  "obstacles":  [ … ],         // default []
  "aisles":     [ … ]          // default []
}
```

Every entity also accepts `metadata: { … }`, an arbitrary object of custom fields. It is
stored per entity and never interpreted by the compiler — use it for whatever your site
needs (temperature, gate number, SKU class).

## warehouse

| Field | Type | Notes |
|---|---|---|
| `code` | string | required; appears in bin codes via `{warehouse}` |
| `name` | string | default `""` |
| `lengthM` | number | along X, from `origin.x` |
| `widthM` | number | along Z, from `origin.z` |
| `heightM` | number | every lane's level stack must fit inside it |
| `origin` | `{x, z}` | default `{x:0, z:0}` — the minimum corner of the floor |
| `id` | string | optional |

## rackTypes — the physical racking

| Field | Type | Notes |
|---|---|---|
| `id` | string | required; lanes reference this |
| `code`, `name` | string | labels only |
| `bayWidthM` | number | the bay pitch; bay count is `floor(lane.lengthM / bayWidthM)` |
| `depthM` | number | how far the rack reaches out from the aisle centreline |
| `uprightWidthM`, `uprightDepthM` | number | default `0.12`; visual only, no layout effect |

## obstacles — pillars, walls, offices

| Field | Type | Notes |
|---|---|---|
| `kind` | `COLUMN` \| `PILLAR` \| `WALL` \| `OFFICE` \| `CUSTOM` | default `CUSTOM` |
| `x`, `z` | number | **minimum corner**, not the centre |
| `widthM`, `depthM`, `heightM` | number | axis-aligned box |

An obstacle must not touch a corridor or a bay — that is an error, not a warning.

## aisles — the corridors

| Field | Type | Notes |
|---|---|---|
| `code` | string | unique; appears in bin codes via `{aisle}` |
| `orientation` | `"X"` \| `"Z"` | must match the centreline, or it is an error |
| `centerline` | `{x1, z1, x2, z2}` | must be **exactly** axis-aligned; diagonals are not supported |
| `widthM` | number | clear corridor between the two rack faces; under 2.5 m warns |
| `travelDirection` | `BOTH` \| `FORWARD` \| `REVERSE` | default `BOTH`; determines which side is LEFT |
| `lanes` | array | default `[]`; an aisle with no lanes warns |

## lanes — one rack row on one side

| Field | Type | Notes |
|---|---|---|
| `code` | string | unique; appears in bin codes via `{lane}` |
| `side` | `"LEFT"` \| `"RIGHT"` | resolved against the travel direction |
| `rackTypeId` | string | must exist, or it is an error |
| `startOffsetM` | number | default `0`; where the run begins along the aisle — this is how you inset a lane |
| `lengthM` | number | `startOffsetM + lengthM` must not exceed the aisle length |
| `levels` | array | at least one; see below |
| `segments` | array | omit for one continuous `RACK` run |
| `skipBays` | number[] | default `[]`; 1-based bay numbers to leave empty |
| `binCodePattern` | string | default `{warehouse}/{aisle}/{side}/B{bay:03}/L{level}` |

### levels

| Field | Notes |
|---|---|
| `clearHeightM` | required; clear opening of the level |
| `binDepthM` | required; should be ≤ the rack type's `depthM` (warns otherwise) |
| `beamHeightM` | default `0.08` |
| `maxWeightKg` | optional; enforced when placing inventory |

Levels are **per lane**, so two lanes in one aisle can have different counts and heights.
Bins per lane = active bays × levels.

### segments — RACK and GAP runs

```json
"segments": [
  { "kind": "RACK", "startM": 0,    "endM": 5.4,  "label": "third 1" },
  { "kind": "GAP",  "startM": 5.4,  "endM": 8.1,  "label": "cross-aisle" },
  { "kind": "RACK", "startM": 8.1,  "endM": 13.5, "label": "third 2" }
]
```

Offsets are metres **along the lane**, starting at `startOffsetM`. Runs must be sorted,
non-overlapping and inside the lane.

**A cross-aisle is a `GAP`**, and the rule that makes it work is worth knowing: a bay
produces bins only when a `RACK` run covers the bay's **centre** (`startOffsetM +
(b + 0.5) × bayWidthM`). A gap that falls between two centres removes nothing. The
`crossAisle.add` command snaps to whole bays for exactly this reason; if you are writing
JSON by hand, put the gap on a bay centre and make `endM − startM` a multiple of
`bayWidthM`.

## Geometry you must get right

The compiler is strict, and the reasons are worth stating because each one is an error you
will otherwise hit:

1. **Rack footprint.** A lane's rack occupies, perpendicular to the centreline,
   `widthM/2 … widthM/2 + rackType.depthM` on its own side. Include that when you space
   aisles, or two lanes will overlap (`LANE_OVERLAP`).
2. **LEFT and RIGHT follow travel, not the compass.** For an aisle running +X, LEFT is −Z
   and RIGHT is +Z. For an aisle running +Z, LEFT is +X and RIGHT is −X.
3. **Everything must be inside the footprint** — the corridor *and* every bay, including
   bays inside gaps and reserved bays (`AISLE_OUT_OF_FOOTPRINT`, `BIN_OUT_OF_FOOTPRINT`).
4. **The level stack must fit the building**: `Σ(beamHeightM + clearHeightM) ≤ heightM`
   (`LEVEL_STACK_EXCEEDS_HEIGHT`).
5. **Bin codes must be unique.** If you customise `binCodePattern`, keep a token that
   distinguishes lanes — `{lane}` or `{side}` — or two lanes will collide
   (`BIN_CODE_DUPLICATE`). Tokens: `{warehouse} {aisle} {lane} {side} {bay} {level}`, with
   optional zero padding like `{bay:03}`.
6. **Do not repeat `id` or `code`** within a document (`AISLE_CODE_DUPLICATE`).

## Checking your file

The editor tells you: import it and read the diagnostics panel and the status bar (bays,
bins, and the publishable badge). Nothing is silently accepted — a refused import says why
and leaves the current layout alone.

To check a batch of files without the UI, add them to a test the way
`src/design/examples.test.ts` does:

```ts
import { buildLayout, migrateToCurrent } from 'layout-core';

const { doc } = migrateToCurrent(JSON.parse(text));
const graph = buildLayout(doc);
console.log(graph.diagnostics, graph.bins.length);
```

`graph.diagnostics` is empty for a clean layout. Errors block publishing; warnings do not,
but the examples here aim for neither.

## Changing the format

Adding an optional field with a default does **not** need a `schemaVersion` bump — old
documents still parse. Bumping the version is for changes that alter *meaning*: renamed
fields, changed units, or a changed default that moves geometry. Every migration needs a
mirror in `server/app/layout/migrate.py`, because the compiler exists in both languages.
