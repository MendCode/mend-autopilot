import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureComponent, splitClip, waitForStableBox } from './capture.mjs';

const box = (y, height = 100, width = 200) => ({ x: 10, y, width, height });

function fakePage({ boxes = [box(10)], text = 'Expected component', count = 1, scrollY = 0 } = {}) {
  let reads = 0;
  const screenshots = [];
  const locator = {
    toString: () => '#component',
    count: async () => count,
    waitFor: async () => {},
    scrollIntoViewIfNeeded: async () => {},
    boundingBox: async () => boxes[Math.min(reads++, boxes.length - 1)],
    textContent: async () => text,
  };
  return {
    locator: () => locator,
    waitForTimeout: async (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    evaluate: async () => scrollY,
    screenshot: async (options) => screenshots.push(options),
    screenshots,
  };
}

test('waits through two changes and returns the stable box', async () => {
  const page = fakePage({ boxes: [box(1), box(10), box(20), box(20), box(20)] });
  assert.deepEqual(await waitForStableBox(page.locator(), { page, settleMs: 1 }), box(20));
});

test('reports the selector and last box if the box does not settle', async () => {
  const page = fakePage();
  let y = 0;
  const locator = { ...page.locator(), boundingBox: async () => box(y += 10) };
  await assert.rejects(waitForStableBox(locator, { page, settleMs: 1, timeoutMs: 10 }), (error) =>
    error instanceof RangeError && /#component.*did not settle.*last box/.test(error.message));
});

test('rejects missing elements and zero-height boxes', async () => {
  const missing = fakePage({ count: 0 });
  await assert.rejects(waitForStableBox(missing.locator(), { page: missing }), /does not exist/);
  const empty = fakePage({ boxes: [box(10, 0)] });
  await assert.rejects(waitForStableBox(empty.locator(), { page: empty }), /zero height/);
});

test('rejects unexpected text before taking screenshots', async () => {
  const page = fakePage({ text: 'Wrong component' });
  await assert.rejects(captureComponent(page, { selector: '#component', expectText: 'Expected', outFile: 'crop.png' }), /Wrong component/);
  assert.equal(page.screenshots.length, 0);
});

test('splits tall and short boxes in page coordinates', () => {
  const clips = splitClip(box(10, 3500), 50, 1600);
  assert.deepEqual(clips.map((clip) => clip.height), [1600, 1600, 300]);
  assert.deepEqual(clips.map((clip) => clip.y), [60, 1660, 3260]);
  assert.deepEqual(splitClip(box(10, 800), 50, 1600), [{ x: 10, y: 60, width: 200, height: 800 }]);
  assert.equal(splitClip(box(0, 100, 3500), 0, 1600).length, 3);
  assert.throws(() => splitClip(box(0), 0, 0), RangeError);
});

test('captures each clip with a distinct filename', async () => {
  const page = fakePage({ boxes: [box(10, 3500)], scrollY: 50 });
  const result = await captureComponent(page, { selector: '#component', expectText: 'Expected', outFile: 'crop.png' });
  assert.deepEqual(result.crops, ['crop-1.png', 'crop-2.png', 'crop-3.png']);
  assert.deepEqual(page.screenshots.map(({ clip }) => clip.y), [60, 1660, 3260]);
  // Scroll-adjusted clips are page coordinates; a viewport screenshot would reject them.
  assert.ok(page.screenshots.every(({ fullPage }) => fullPage === true));
});
