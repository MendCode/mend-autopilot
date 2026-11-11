#!/usr/bin/env node
// Writes the README images in docs/assets/: the logo, and the banner and pipeline diagram in a light and
// a dark version from one template each, so the two themes never drift apart. Stdlib only.
// usage: node scripts/render-assets.mjs [--check]   (--check compares instead of writing; exit 1 on drift)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'assets');

const THEMES = {
  light: { panel: '#FFFFFF', ink: '#16181D', muted: '#62666D', rule: '#E2DED5', lane: '#F3F1EC', thread: '#D9480F', pass: '#2B8A3E', fail: '#C92A2A' },
  dark: { panel: '#161920', ink: '#ECEDEF', muted: '#9AA0A8', rule: '#2B2F37', lane: '#13161C', thread: '#FF7B3A', pass: '#51CF66', fail: '#FF6B6B' },
};

const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The mark: a check whose short leg is still stitched (unverified) and whose long leg is drawn solid. */
function mark({ x, y, size, t }) {
  const s = size / 64;
  const p = (px, py) => `${(x + px * s).toFixed(2)} ${(y + py * s).toFixed(2)}`;
  const n = (value) => (value * s).toFixed(2);
  return `<rect x="${(x + 2 * s).toFixed(2)}" y="${(y + 2 * s).toFixed(2)}" width="${n(60)}" height="${n(60)}" rx="${n(15)}" fill="${t.panel}" stroke="${t.ink}" stroke-width="${n(2.5)}"/>
  <path d="M ${p(13, 33)} L ${p(26, 46)}" stroke="${t.thread}" stroke-width="${n(5.5)}" stroke-linecap="round" stroke-dasharray="${n(4)} ${n(5)}" fill="none"/>
  <path d="M ${p(26, 46)} L ${p(51, 19)}" stroke="${t.ink}" stroke-width="${n(6)}" stroke-linecap="round" fill="none"/>`;
}

function logo() {
  const t = THEMES.light;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 64 64" role="img" aria-label="mend-autopilot logo">
  ${mark({ x: 0, y: 0, size: 64, t })}
</svg>
`;
}

function banner(t) {
  const W = 1280, H = 350;
  const cardX = 652, cardY = 64, cardW = 564, cardH = 300;
  const rows = [
    ['checks', 'bun test', 'exit 0', 'pass'],
    ['red-green', 'test', 'fails before, passes after', 'pass'],
    ['integrity', 'tests and secrets', 'nothing weakened', 'pass'],
    ['scope', 'edit set', '2 files, all allowed', 'pass'],
    ['auditor', 'own session', 'PASS, 7 steps driven', 'pass'],
  ];
  const rowY = (index) => cardY + 112 + index * 36;
  const rowsSvg = rows.map(([lane, what, result], index) => `
    <circle cx="${cardX + 30}" cy="${rowY(index) - 5}" r="5" fill="${t.pass}"/>
    <text x="${cardX + 46}" y="${rowY(index)}" font-family="${MONO}" font-size="17" fill="${t.ink}">${escape(lane)}</text>
    <text x="${cardX + 168}" y="${rowY(index)}" font-family="${MONO}" font-size="17" fill="${t.muted}">${escape(what)}</text>
    <text x="${cardX + cardW - 24}" y="${rowY(index)}" font-family="${MONO}" font-size="17" fill="${t.ink}" text-anchor="end">${escape(result)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="mend-autopilot: small pull requests from cheap models, with the evidence to merge them">
  <g transform="translate(0 -28)">

  ${mark({ x: 64, y: 84, size: 72, t })}
  <text x="64" y="214" font-family="${SANS}" font-size="52" font-weight="650" letter-spacing="-1" fill="${t.ink}">mend-autopilot</text>
  <text x="64" y="262" font-family="${SANS}" font-size="24" fill="${t.ink}">Small pull requests from cheap models,</text>
  <text x="64" y="294" font-family="${SANS}" font-size="24" fill="${t.ink}">with the evidence to merge them.</text>
  <text x="64" y="340" font-family="${MONO}" font-size="18" fill="${t.muted}">for MendCode: ChatGPT, Claude, OpenCode Go</text>
  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="14" fill="${t.panel}" stroke="${t.rule}" stroke-width="2"/>
  <text x="${cardX + 24}" y="${cardY + 40}" font-family="${MONO}" font-size="16" fill="${t.muted}">evidence card</text>
  <text x="${cardX + 24}" y="${cardY + 64}" font-family="${MONO}" font-size="19" font-weight="600" fill="${t.ink}">pagination-bounds</text>
  <rect x="${cardX + cardW - 152}" y="${cardY + 26}" width="128" height="32" rx="16" fill="none" stroke="${t.pass}" stroke-width="2"/>
  <text x="${cardX + cardW - 88}" y="${cardY + 47}" font-family="${MONO}" font-size="14" font-weight="600" fill="${t.pass}" text-anchor="middle">merge-ready</text>
  <path d="M ${cardX + 24} ${cardY + 76} H ${cardX + cardW - 24}" stroke="${t.rule}" stroke-width="1.5"/>${rowsSvg}
  </g>
</svg>
`;
}

function pipeline(t) {
  const W = 1280, H = 690;
  const lanes = [
    ['You', ['write the item,', 'approve the merge']],
    ['Strong model', ['plans and reviews,', 'never implements']],
    ['Cheap model', ['does the work in', 'its own worktree']],
    ['Programs', ['decide what counts', 'as verified']],
  ];
  const laneTop = 112, laneH = 128;
  const laneY = (index) => laneTop + index * laneH;
  const mid = (index) => laneY(index) + laneH / 2;
  const nodeW = 150, nodeH = 80, gap = 22;
  const col = (index) => 230 + index * (nodeW + gap) + nodeW / 2;
  const left = (c) => col(c) - nodeW / 2, right = (c) => col(c) + nodeW / 2;
  const top = (lane) => mid(lane) - nodeH / 2, bottom = (lane) => mid(lane) + nodeH / 2;
  const line = (d, color = t.muted, extra = '') => `<path d="${d}" stroke="${color}" stroke-width="2" fill="none" stroke-linejoin="round"${extra}/>`;
  const head = (x, y, direction, color = t.muted) => {
    const shapes = { right: `M ${x - 10} ${y - 6} L ${x} ${y} L ${x - 10} ${y + 6}`, up: `M ${x - 6} ${y + 10} L ${x} ${y} L ${x + 6} ${y + 10}`, down: `M ${x - 6} ${y - 10} L ${x} ${y} L ${x + 6} ${y - 10}` };
    return line(shapes[direction], color);
  };
  const node = (c, lane, lines, accent = t.ink, dashed = false) => {
    const text = lines.map((value, index) => `<text x="${col(c)}" y="${mid(lane) + (index - (lines.length - 1) / 2) * 24 + 7}" font-family="${SANS}" font-size="19" fill="${t.ink}" text-anchor="middle">${escape(value)}</text>`).join('');
    return `<rect x="${left(c)}" y="${top(lane)}" width="${nodeW}" height="${nodeH}" rx="12" fill="${t.panel}" stroke="${accent}" stroke-width="2"${dashed ? ' stroke-dasharray="6 6"' : ''}/>${text}`;
  };
  /** Right side of one node to the left side of a node in the next column, through the gap between them. */
  const elbow = (fromC, fromLane, toC, toLane, offset = 0) => {
    const x1 = right(fromC), y1 = mid(fromLane) + offset, x2 = left(toC), y2 = mid(toLane) + offset, xm = x1 + gap / 2;
    const d = y1 === y2 ? `M ${x1} ${y1} H ${x2 - 1}` : `M ${x1} ${y1} H ${xm} V ${y2} H ${x2 - 1}`;
    return line(d) + head(x2, y2, 'right');
  };
  const lanesSvg = lanes.map(([name, role], index) => `
  <rect x="40" y="${laneY(index) + 4}" width="${W - 80}" height="${laneH - 8}" rx="14" fill="${t.lane}"/>
  <text x="64" y="${mid(index) - 12}" font-family="${SANS}" font-size="21" font-weight="650" fill="${t.ink}">${escape(name)}</text>
  <text x="64" y="${mid(index) + 16}" font-family="${SANS}" font-size="16" fill="${t.muted}">${escape(role[0])}</text>
  <text x="64" y="${mid(index) + 37}" font-family="${SANS}" font-size="16" fill="${t.muted}">${escape(role[1])}</text>`).join('');
  const phase = (fromC, toC, label) => {
    const x1 = left(fromC), x2 = right(toC);
    return `${line(`M ${x1} 84 H ${x2} M ${x1} 78 V 90 M ${x2} 78 V 90`, t.rule)}
  <text x="${(x1 + x2) / 2}" y="68" font-family="${MONO}" font-size="18" fill="${t.muted}" text-anchor="middle">${escape(label)}</text>`;
  };
  const loopStartX = left(3), loopEndX = col(2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="How one item becomes a pull request: you write the item; the strong model writes a spec; the cheap model implements and commits; programs run the checks, the scope check and the integrity scan; the strong model reviews and can send one fix round; on a clean checkout programs repeat the checks and the red-green test while an auditor drives the change in its own session; the evidence card is written; you approve the merge.">
  <text x="40" y="40" font-family="${SANS}" font-size="24" font-weight="650" fill="${t.ink}">One item, one pull request</text>
  ${phase(1, 3, 'mend-lite')}
  ${phase(4, 5, 'mend-lite-pr')}${lanesSvg}
  ${node(0, 0, ['Item', 'goal, checks'])}
  ${node(1, 1, ['Spec'])}
  ${node(2, 2, ['Implement', 'and commit'], t.thread, true)}
  ${node(3, 3, ['Checks, scope', 'and integrity'])}
  ${node(3, 1, ['Review'])}
  ${node(4, 3, ['Checks again', 'and red-green'])}
  ${node(4, 1, ['Auditor', 'own session'])}
  ${node(5, 3, ['Evidence card'], t.pass)}
  ${node(5, 0, ['Approve', 'the merge'])}
  ${elbow(0, 0, 1, 1)}
  ${elbow(1, 1, 2, 2)}
  ${elbow(2, 2, 3, 3)}
  ${line(`M ${col(3)} ${top(3)} V ${bottom(1) + 1}`)}${head(col(3), bottom(1), 'up')}
  ${line(`M ${loopStartX} ${mid(1) + 20} H ${loopEndX} V ${top(2) - 1}`, t.thread, ' stroke-dasharray="2 6" stroke-linecap="round"')}${head(loopEndX, top(2), 'down', t.thread)}
  <text x="${loopEndX + 12}" y="${mid(1) + 62}" font-family="${SANS}" font-size="16" fill="${t.thread}">one fix round</text>
  ${elbow(3, 1, 4, 1)}
  ${elbow(3, 1, 4, 3, -14)}
  ${elbow(4, 3, 5, 3)}
  ${elbow(4, 1, 5, 3, -20)}
  ${line(`M ${col(5)} ${top(3)} V ${bottom(0) + 1}`)}${head(col(5), bottom(0), 'up')}
  <text x="40" y="${laneTop + 4 * laneH + 40}" font-family="${SANS}" font-size="17" fill="${t.muted}">Any step can stop the item with a reason: blocked, or draft when its rounds are spent. Nothing is pushed or merged for you.</text>
</svg>
`;
}

const files = {
  'logo.svg': logo(),
  'banner-light.svg': banner(THEMES.light),
  'banner-dark.svg': banner(THEMES.dark),
  'pipeline-light.svg': pipeline(THEMES.light),
  'pipeline-dark.svg': pipeline(THEMES.dark),
};

const check = process.argv.includes('--check');
let drift = 0;
await fs.mkdir(OUT, { recursive: true });
for (const [name, content] of Object.entries(files)) {
  const target = path.join(OUT, name);
  if (check) {
    const current = await fs.readFile(target, 'utf8').catch(() => null);
    if (current !== content) { drift += 1; console.error(`render-assets: ${name} differs from the template`); }
  } else {
    await fs.writeFile(target, content);
  }
}
process.exit(drift ? 1 : 0);
