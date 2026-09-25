/**
 * End-to-end journeys, in a real browser.
 *
 * These are the claims the unit suites cannot make, because they depend on the whole
 * application being wired together:
 *
 *  1. a real edit through a real input reaches the compiler;
 *  2. undo puts it back;
 *  3. the publish gate follows what the compiler said;
 *  4. the layout designed in Design mode is the layout Operate mode renders.
 *
 * Assertions read numbers out of the status bar rather than pixels out of the canvas.
 * Headless WebGL works, but pixel output is not what is under test — the compiled counts
 * are, and they are displayed precisely because they are the numbers that matter.
 *
 * Nothing here clicks in the 3D canvas. A raycast against a 360-bin instanced mesh is a
 * legitimate thing to test, but it is a test of the canvas rather than of the application,
 * and it is the least stable part of the suite. The structure tree drives the same commands.
 */
import { expect, test, type Page } from '@playwright/test';

/** The app's own summary of its compiled state, read from the status bar. */
async function counts(page: Page): Promise<{ bays: number; bins: number }> {
  const items = page.locator('.status .status-item');
  const numberOf = async (index: number) =>
    Number((await items.nth(index).innerText()).match(/(\d+)/)?.[1] ?? -1);

  return { bays: await numberOf(0), bins: await numberOf(1) };
}

/** A numeric inspector field, found by its visible label. */
function field(page: Page, label: string) {
  return page.locator('.field', { hasText: label }).first().locator('input');
}

async function commitField(page: Page, label: string, value: string): Promise<void> {
  const input = field(page, label);
  await input.fill(value);
  await input.press('Enter');
}

/**
 * Wait for design mode to be up. The canvas is a separate React root, so the status bar is
 * the signal that the store and the compiler are ready.
 */
async function openDesign(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.status')).toContainText('bins');
  expect((await counts(page)).bins).toBeGreaterThan(0);
}

test.describe('Design mode', () => {
  test('opens on a clean, publishable layout', async ({ page }) => {
    await openDesign(page);

    await expect(page.locator('.status .badge')).toHaveText('Publishable');
  });

  test('an edit reaches the compiler, and undo puts it back', async ({ page }) => {
    await openDesign(page);
    const before = await counts(page);

    // Select a lane in the structure tree. The lane editor is only reachable once a lane is
    // selected, because a lane has no mesh of its own in the 3D view.
    await page.locator('.tree-row .tree-pick[title^="Lane "]').first().click();
    await expect(field(page, 'Run length')).toBeVisible();

    // Shorten the run to five bays. Bays are re-derived, so bins must fall; shortening a
    // lane cannot push anything outside the footprint.
    await commitField(page, 'Run length', '13.5');

    // One commit, one undo entry. This is the regression that made a single Enter press
    // dispatch twice: the key handler committed, then the blur it triggered committed again
    // from a stale closure, so the first undo appeared to do nothing.
    await expect(page.locator('.topbar-group .status-item')).toHaveText('1 edit');

    await expect
      .poll(async () => (await counts(page)).bins, { message: 'bins should drop' })
      .toBeLessThan(before.bins);
    expect((await counts(page)).bins).toBeGreaterThan(0);
    await expect(page.locator('.status .badge')).toHaveText('Publishable');

    // A single undo is enough, because there was only ever one edit.
    await page.getByRole('button', { name: '↶' }).click();

    await expect
      .poll(async () => (await counts(page)).bins, { message: 'undo should restore' })
      .toBe(before.bins);
    expect((await counts(page)).bays).toBe(before.bays);
    await expect(page.locator('.topbar-group .status-item')).toHaveText('0 edits');
  });

  test('a cross-aisle cuts every lane in one edit, and one undo takes it back', async ({
    page,
  }) => {
    await openDesign(page);
    const before = await counts(page);

    // The route is authored from the structure tree, like every other structural edit, so
    // this exercises the command rather than a canvas raycast.
    await page
      .getByTitle('Cut a cross-aisle through every lane of this aisle, at the middle')
      .first()
      .click();

    // One aisle's two lanes lose one bay each, at five levels. One command, so one
    // history entry — and undo has to take the whole route back in one step.
    await expect(page.locator('.topbar-group .status-item')).toHaveText('1 edit');
    await expect
      .poll(async () => (await counts(page)).bins, { message: 'the route should remove bins' })
      .toBe(before.bins - 10);

    // Bays are still counted — a gap removes bay *binning*, not the bay itself.
    expect((await counts(page)).bays).toBe(before.bays);
    await expect(page.locator('.status .badge')).toHaveText('Publishable');

    await page.getByRole('button', { name: '↶' }).click();

    await expect
      .poll(async () => (await counts(page)).bins, { message: 'undo should restore the racking' })
      .toBe(before.bins);
    await expect(page.locator('.topbar-group .status-item')).toHaveText('0 edits');
  });

  test('Escape discards a typed value instead of committing it', async ({ page }) => {    await openDesign(page);
    const before = await counts(page);

    await page.locator('.tree-row .tree-pick[title^="Lane "]').first().click();
    const input = field(page, 'Run length');
    await expect(input).toBeVisible();
    const original = await input.inputValue();

    await input.fill('13.5');
    await input.press('Escape');

    // Reverting must not record an edit. The blur that follows Escape used to commit the
    // discarded draft, so this asserted the opposite of the documented behaviour.
    await expect(page.locator('.topbar-group .status-item')).toHaveText('0 edits');
    await expect(input).toHaveValue(original);
    expect((await counts(page)).bins).toBe(before.bins);

    // Leaving the field without an edit must also stay silent.
    await input.blur();
    await expect(page.locator('.topbar-group .status-item')).toHaveText('0 edits');
  });

  test('the publish gate follows the compiler and names what is wrong', async ({ page }) => {
    await openDesign(page);

    // Shrink the building until the aisles no longer fit inside it: a real, fixable error.
    await commitField(page, 'Length (X)', '5');

    const badge = page.locator('.status .badge');
    await expect(badge).toHaveText('Blocked');

    await page.getByRole('button', { name: 'Publish…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Publish layout' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.gate')).toContainText('Blocked by');
    await expect(dialog.locator('.publish-issue-error').first()).toContainText(
      'AISLE_OUT_OF_FOOTPRINT',
    );
    await expect(dialog.getByRole('button', { name: 'Blocked' })).toBeDisabled();

    // Fixing it enables publishing — the whole point of the gate.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await commitField(page, 'Length (X)', '40');
    await expect(badge).toHaveText('Publishable');

    await page.getByRole('button', { name: 'Publish…' }).click();
    await expect(
      page
        .getByRole('dialog', { name: 'Publish layout' })
        .getByRole('button', { name: 'Review payload' }),
    ).toBeEnabled();
  });

  test('warnings inform, and do not block publishing', async ({ page }) => {
    await openDesign(page);

    // A lane shorter than one bay: LANE_ZERO_BAYS is a warning, not an error.
    await page.locator('.tree-row .tree-pick[title^="Lane "]').first().click();
    await commitField(page, 'Run length', '1');

    const badge = page.locator('.status .badge');
    await expect(badge).toHaveText('Publishable with warnings');

    await page.getByRole('button', { name: 'Publish…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Publish layout' });
    await expect(dialog.locator('.gate')).toContainText('Ready, with');
    await expect(dialog.getByRole('button', { name: 'Review payload' })).toBeEnabled();
  });
});

test.describe('Design mode and Operate mode agree', () => {
  test('operate mode reports the bins the designer compiled', async ({ page }) => {
    await openDesign(page);
    const designed = await counts(page);

    await page.getByRole('button', { name: 'Operate mode →' }).click();

    // No API is running, so operate mode shows the working copy — the same document the
    // designer just compiled. The counts must match.
    await expect(page.locator('.operate-source')).toContainText(/working copy/i);
    await expect(page.locator('.operate-head p')).toContainText(`${designed.bins} bins`);

    // The route toggle reads the real aisles.
    await page.getByRole('button', { name: 'Show route' }).click();
    await expect(page.getByRole('button', { name: 'Hide route' })).toBeVisible();

    // The filters are the operator's only controls, and none of them writes.
    await page.getByRole('button', { name: /Empty/ }).click();
    await expect(page.locator('.operate-head p')).toContainText(`${designed.bins} bins`);

    await page.getByRole('button', { name: '← Back to design' }).click();
    await expect(page.locator('.status')).toContainText('bins');
    expect((await counts(page)).bins).toBe(designed.bins);
  });

  test('an edit made in design mode is what operate mode then shows', async ({ page }) => {
    await openDesign(page);

    await page.locator('.tree-row .tree-pick[title^="Lane "]').first().click();
    await commitField(page, 'Run length', '13.5');
    const edited = await counts(page);
    expect(edited.bins).not.toBe(360);

    await page.getByRole('button', { name: 'Operate mode →' }).click();
    await expect(page.locator('.operate-head p')).toContainText(`${edited.bins} bins`);
  });
});
