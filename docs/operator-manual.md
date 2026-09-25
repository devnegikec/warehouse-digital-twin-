# Operator manual

For people running a warehouse, not designing one. Designing is covered in
`warehouse-designer-plan.md`.

## What you are looking at

Two modes, one document:

- **Design** — where the layout is authored. Nothing you do in Operate mode changes it.
- **Operate** — a read-only view of a layout with inventory in it. This manual covers this
  mode.

You cannot damage anything from Operate mode. Every control is a filter or a view toggle;
none of them writes.

## Knowing which layout you are seeing

The badge at the top left is the first thing to read, because the same warehouse can look
identical in two very different states:

| Badge | Meaning |
|---|---|
| **Published v3** | The frozen, live layout. This is what operations should act on. |
| **Working copy (not published)** | A layout being edited that has never been published, or whose edits are not live yet. |
| **Working copy (offline)** | No server is connected, so this is whatever the browser has. |

If the badge says *working copy*, the numbers below it are provisional and nobody else can
see them.

## Finding things

### Filtering

The filter list on the left narrows the 3D view to bins in one state. Filtered-out bins keep
their shape but lose their colour, so the racking stays readable rather than appearing to
disappear.

| State | What it means |
|---|---|
| **Empty** | Nothing is stored in the bin. |
| **Low stock** | Something is stored, but less than half the usable volume. |
| **Current stock** | Stored and reasonably full. |
| **Slow moving** | Nothing has changed in this bin for **30 days or more**. |

Slow moving takes priority over low stock: a half-empty bin that nobody has touched in a
month is a slotting problem, and that is the more useful thing to see. If a bin is empty it
is always reported as empty, whatever else is true of it.

Colours mean the same thing in the filter list, in the 3D view, and in the bin card.

### Inspecting a bin

Hover a bin for a summary; click it for the details panel. It shows:

- **SKU and quantity** — the largest placement in the bin, and how many other SKUs share it.
- **Aisle / lane / bay / level** — where it physically is.
- **Fill** — percentage of the bin's usable volume in use. "Usable" already accounts for the
  85% utilisation allowance, so 100% means full, not overflowing.
- **Weight** — used against the level's beam limit, highlighted when over 90%. A bin with no
  limit shows just the weight.
- **Last moved** — days since anything in this bin changed, highlighted from 30 days.

### The picking route

**Show route** draws a serpentine path: down one aisle, across, up the next. It follows the
aisles that exist in the layout, so it stays correct when the layout changes. It is a
*demonstration* of a walkable route, not an optimised pick path — the optimiser is not built.

## Reading the layout figures

At the top of the panel:

- **bins / occupied** — how many bins the layout has, and how many hold anything.
- **% of usable volume in use** — across the *whole* warehouse, not per bin. A warehouse at
  40% is not necessarily badly used: fast-moving goods in a third of the bins can be exactly
  right.
- **Oldest movement** — the longest anything has sat untouched, or "no stock" if the warehouse
  is empty. This is the number to watch for dead inventory.

## What you cannot do here

- **Move stock.** Placements are made in Design mode by dragging SKUs onto bins, where the fit
  and weight limits are enforced. If you need a bin filled in a hurry, ask whoever designs
  the layout.
- **Change the layout.** Aisles, levels, rack runs and gaps are all authored in Design mode.
- **See history.** Operate mode shows the current state. Version history exists — every
  publish is recorded with its document hash and diagnostics — but is not surfaced in the UI
  yet.

## When something looks wrong

**A bin reads Empty but you can see stock on it.** Empty means *nothing is recorded*, which
is a data problem rather than a display problem. Check which version you are looking at: a
working copy does not carry the live placements, so everything reads empty there.

**The layout on screen is not the one you published.** Look at the badge. If it says
*working copy*, publish from Design mode, then **Reload**.

**"Compiler drift" appears in a red bar.** The browser and the server computed different
layouts for the same document, and the server refused to store it. This is a bug in the
software, not a mistake you made: the layout shown is the previous good version. Report it
with the short hash shown next to the badge.

**A bin is full but the fill percentage is low.** Fill is *volume*; weight is separate. A
small number of dense items can hit the beam limit while the bin looks mostly empty. The
weight row is highlighted in that case.

**Numbers do not add up between two screens.** Reload. The figures are computed from one
snapshot each time; comparing a stale tab against a fresh one will not reconcile.
