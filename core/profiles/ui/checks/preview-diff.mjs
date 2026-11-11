// Integration diff (G5): the integrated layout keeps the block order and relative sizes of the approved preview.
// Rects are normalized to the container width so a preview and a page of different widths compare.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DEFAULT_RULES, resolveRules } from './ui-rubric.mjs';

export const DEFAULT_TOLERANCE = DEFAULT_RULES.layoutTolerance;
const EPSILON = 1e-9;
const EVIDENCE_DIR = path.join('.mend', 'evidence');
const LAYOUT_FILE = 'layout.json';

function normalize(layout, label) {
  const width = layout?.containerWidth;
  if (!Number.isFinite(width) || width <= 0) throw new TypeError(`[PREVIEW-DIFF]: ${label}.containerWidth must be a positive number`);
  if (!Array.isArray(layout.blocks)) throw new TypeError(`[PREVIEW-DIFF]: ${label}.blocks must be an array`);
  return layout.blocks.map(({ id, rect }) => ({
    id,
    x: rect.x / width,
    y: rect.y / width,
    width: rect.width / width,
    height: rect.height / width,
  }));
}

/** Blocks grouped into rows by vertical overlap, each row ordered left to right. */
function rowsOf(blocks) {
  const sorted = [...blocks].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const block of sorted) {
    const row = rows.at(-1);
    if (row && block.y < Math.min(...row.map((entry) => entry.y + entry.height)) - EPSILON) row.push(block);
    else rows.push([block]);
  }
  return rows.map((row) => row.sort((a, b) => a.x - b.x));
}

function signature(rows) {
  return rows.map((row) => row.map((block) => block.id).join('/')).join(' | ');
}

function describe(rows, tolerance) {
  const all = rows.flat();
  const widest = Math.max(...rows.map((row) => row.length));
  const sameWidth = all.every((block) => Math.abs(block.width - all[0].width) <= tolerance + EPSILON);
  if (widest >= 2 && sameWidth && all.length > 1) return widest === 2 ? 'equal-width pairs' : `equal-width rows of ${widest}`;
  return signature(rows);
}

export function compareLayouts({ preview, integrated, tolerance = DEFAULT_TOLERANCE }) {
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new RangeError('[PREVIEW-DIFF]: tolerance must be a non-negative number');
  const before = normalize(preview, 'preview');
  const after = normalize(integrated, 'integrated');
  const afterIds = new Set(after.map((block) => block.id));
  const beforeIds = new Set(before.map((block) => block.id));
  const failures = [];

  if (before.length === 0 || after.length === 0) failures.push({ target: '(layout)', rule: 'layout-empty', detail: 'preview and integrated layouts must each contain blocks' });

  for (const block of before) if (!afterIds.has(block.id)) failures.push({ target: block.id, rule: 'block-missing', detail: `block ${block.id} is in the preview but not in the integration` });
  for (const block of after) if (!beforeIds.has(block.id)) failures.push({ target: block.id, rule: 'block-extra', detail: `block ${block.id} is in the integration but not in the preview` });

  const commonBefore = before.filter((block) => afterIds.has(block.id));
  const commonAfter = after.filter((block) => beforeIds.has(block.id));
  const rowsBefore = rowsOf(commonBefore);
  const rowsAfter = rowsOf(commonAfter);
  if (commonBefore.length > 0 && signature(rowsBefore) !== signature(rowsAfter)) {
    failures.push({ target: '(layout)', rule: 'block-order', detail: `block order ${describe(rowsBefore, tolerance)} vs ${describe(rowsAfter, tolerance)}` });
  }

  let maxDelta = 0;
  const afterById = new Map(commonAfter.map((block) => [block.id, block]));
  for (const block of commonBefore) {
    const other = afterById.get(block.id);
    const widthDelta = Math.abs(block.width - other.width);
    const heightDelta = Math.abs(block.height - other.height);
    const delta = Math.max(widthDelta, heightDelta);
    maxDelta = Math.max(maxDelta, delta);
    if (delta > tolerance + EPSILON) {
      const which = widthDelta >= heightDelta ? 'width' : 'height';
      failures.push({
        target: block.id,
        rule: 'block-size',
        detail: `block ${block.id} ${which} ${block[which].toFixed(2)} vs ${other[which].toFixed(2)} of container width (tolerance ${tolerance})`,
      });
    }
  }
  return { pass: failures.length === 0, maxDelta, mismatches: failures.map((failure) => failure.detail), failures };
}

async function readLayoutFile(repo, itemId) {
  try {
    return JSON.parse(await fs.readFile(path.join(repo, EVIDENCE_DIR, itemId, LAYOUT_FILE), 'utf8'));
  } catch {
    return null;
  }
}

export default {
  id: 'preview-diff',
  description: 'The integrated layout keeps the approved preview block order and relative sizes within tolerance.',
  async run({ repo, item, config }) {
    const { rules, overrides } = resolveRules(config?.ui ?? {});
    const layout = item?.id ? await readLayoutFile(repo, item.id) : null;
    if (!layout) {
      return {
        pass: false,
        failures: [{ target: '(item)', rule: 'layout-missing', detail: `no ${path.join(EVIDENCE_DIR, item?.id ?? '<item>', LAYOUT_FILE)} with preview and integrated block rects` }],
        overrides,
      };
    }
    const result = compareLayouts({ preview: layout.preview, integrated: layout.integrated, tolerance: rules.layoutTolerance });
    return { pass: result.pass, failures: result.failures, maxDelta: result.maxDelta, overrides };
  },
  async runFixture(fixture) {
    const result = compareLayouts({ preview: fixture.preview, integrated: fixture.integrated, tolerance: fixture.tolerance });
    return { pass: result.pass, failures: result.failures, maxDelta: result.maxDelta };
  },
};
