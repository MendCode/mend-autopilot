// Capture component evidence only after its geometry has settled.
export async function waitForStableBox(locator, { page, settleMs = 250, stableReads = 3, timeoutMs = 15000, tolerancePx = 1 }) {
  if (!Number.isFinite(settleMs) || settleMs < 0 || !Number.isInteger(stableReads) || stableReads < 1 ||
      !Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(tolerancePx) || tolerancePx < 0) {
    throw new RangeError('[CAPTURE]: invalid stability options');
  }
  const selector = String(locator);
  const deadline = Date.now() + timeoutMs;
  if (await locator.count() === 0) throw new Error(`[CAPTURE]: ${selector} does not exist`);
  await locator.waitFor({ state: 'attached', timeout: timeoutMs });
  await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs });

  let previous = null;
  let consecutive = 0;
  while (true) {
    const box = await locator.boundingBox();
    if (!box) throw new Error(`[CAPTURE]: ${selector} does not exist or has no bounding box`);
    if (box.height <= 0 || box.width <= 0) throw new Error(`[CAPTURE]: ${selector} has zero height or width`);
    const same = previous && ['x', 'y', 'width', 'height'].every((key) => Math.abs(box[key] - previous[key]) <= tolerancePx);
    consecutive = same ? consecutive + 1 : 1;
    previous = box;
    if (consecutive >= stableReads && Date.now() <= deadline) return box;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new RangeError(`[CAPTURE]: ${selector} did not settle; last box: ${JSON.stringify(box)}`);
    await page.waitForTimeout(Math.min(settleMs, remaining));
  }
}

// Tile both axes so no screenshot exceeds the requested maximum side length.
export function splitClip(box, scrollY, maxSidePx) {
  if (!Number.isFinite(maxSidePx) || maxSidePx <= 0) throw new RangeError('[CAPTURE]: maxSidePx must be positive');
  if (!box || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(box[key])) ||
      box.width <= 0 || box.height <= 0 || !Number.isFinite(scrollY)) {
    throw new RangeError('[CAPTURE]: invalid box or scrollY');
  }
  const clips = [];
  for (let y = 0; y < box.height; y += maxSidePx) {
    for (let x = 0; x < box.width; x += maxSidePx) {
      clips.push({ x: box.x + x, y: box.y + scrollY + y, width: Math.min(maxSidePx, box.width - x), height: Math.min(maxSidePx, box.height - y) });
    }
  }
  return clips;
}

export async function captureComponent(page, { selector, expectText, outFile, maxSidePx = 1600 }) {
  const locator = page.locator(selector);
  const box = await waitForStableBox(locator, { page });
  if (expectText !== undefined) {
    const text = await locator.textContent();
    if (!(text ?? '').includes(expectText)) throw new Error(`[CAPTURE]: ${selector} expected text ${JSON.stringify(expectText)}; found ${JSON.stringify(text)}`);
  }
  const scrollY = await page.evaluate(() => window.scrollY);
  const clips = splitClip(box, scrollY, maxSidePx);
  const crops = [];
  for (let i = 0; i < clips.length; i++) {
    const file = clips.length === 1 ? outFile : outFile.replace(/(\.[^./\\]+)?$/, `-${i + 1}$1`);
    // Clips are in page coordinates (box + scroll), which a screenshot only honours over the full page.
    await page.screenshot({ path: file, clip: clips[i], fullPage: true });
    crops.push(file);
  }
  return { box, crops };
}
