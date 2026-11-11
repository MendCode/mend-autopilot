#!/usr/bin/env node
// Writes the README images in docs/assets/, each in a light and a dark version from one template so the
// two themes never drift apart. The visual language follows MendCode's own README: its logo, a terminal
// window frame, monospace type, neutral grays and the MendCode teal for what passed. Stdlib only.
// usage: node scripts/render-assets.mjs [--check]   (--check compares instead of writing; exit 1 on drift)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'assets');

const THEMES = {
  light: { window: '#FAFAFA', frame: '#D4D4D4', bar: '#EFEFEF', dot: '#C8C8C8', ink: '#0A0A0A', text: '#3A3A3A', muted: '#6B6B6B', faint: '#A3A3A3', rule: '#E2E2E2', panel: '#FFFFFF', teal: '#2F7A6F', sage: '#6F8A5C', amber: '#A86A12', logo: '#0A130F' },
  dark: { window: '#0A0A0A', frame: '#3A3F3C', bar: '#141414', dot: '#3A3A3A', ink: '#FAFAFA', text: '#D4D4D4', muted: '#8A8A8A', faint: '#606060', rule: '#262626', panel: '#121212', teal: '#5FB3A6', sage: '#9FB08E', amber: '#E0A450', logo: '#D9DBCC' },
};

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = (x, y, value, { size = 15, fill, weight, anchor } = {}) => `<text x="${x}" y="${y}" font-family="${MONO}" font-size="${size}"${weight ? ` font-weight="${weight}"` : ''}${anchor ? ` text-anchor="${anchor}"` : ''} fill="${fill}">${escape(value)}</text>`;

/** MendCode's mark, the same path its README uses. */
const KNOT = 'M 438 341 L 355 450 L 160 450 L 60 350 L 60 170 L 160 70 L 355 70 L 645 450 L 840 450 L 940 350 L 940 170 L 840 70 L 645 70 L 562 179';
const logo = (t) => `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="104" viewBox="0 0 1000 520" role="img" aria-label="MendCode"><path d="${KNOT}" fill="none" stroke="${t.logo}" stroke-width="88" stroke-linejoin="bevel"/></svg>
`;

/** A terminal window like the ones in MendCode's README: frame, title bar with three dots, centered title. */
function windowFrame(t, W, H, title, body, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escape(label)}">
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="12" fill="${t.window}" stroke="${t.frame}" stroke-width="1.5"/>
  <path d="M 1 13 Q 1 1 13 1 H ${W - 13} Q ${W - 1} 1 ${W - 1} 13 V 40 H 1 Z" fill="${t.bar}"/>
  <path d="M 1 40 H ${W - 1}" stroke="${t.frame}" stroke-width="1"/>
  <circle cx="22" cy="21" r="6" fill="${t.dot}"/><circle cx="42" cy="21" r="6" fill="${t.dot}"/><circle cx="62" cy="21" r="6" fill="${t.dot}"/>
  ${text(W / 2, 26, title, { size: 14, fill: t.muted, anchor: 'middle' })}
${body}
</svg>
`;
}

/** The queue: every item is a row of steps colored by who does them, so the split is visible at a glance. */
function overview(t) {
  const W = 1280, H = 640;
  const who = {
    cheap: { label: 'cheap model', fill: t.sage, ink: t.window },
    strong: { label: 'strong model', fill: 'none', stroke: t.teal, ink: t.teal },
    program: { label: 'programs', fill: 'none', stroke: t.faint, ink: t.muted },
  };
  const steps = [['spec', 'strong'], ['writes the code', 'cheap'], ['checks', 'program'], ['review', 'strong'], ['audit', 'strong']];
  const widths = [96, 236, 112, 104, 96];
  const items = [
    ['pagination-bounds', 5, 'merge-ready'],
    ['revenue-axis-empty', 5, 'merge-ready'],
    ['search-wildcards', 5, 'merge-ready'],
    ['status-filter', 5, 'merge-ready'],
    ['csv-export-header', 4, 'draft', 'review asked twice'],
    ['login-rate-limit', 3, 'blocked', 'guard refused a command'],
  ];
  const nameX = 48, stepX = 292, gap = 8, resultX = 1012;
  const rowY = (index) => 214 + index * 56;
  const chip = (x, y, w, kind, label, faded) => {
    const k = who[kind];
    const stroke = k.stroke ? ` stroke="${k.stroke}" stroke-width="1.5"` : '';
    return `<g${faded ? ' opacity="0.28"' : ''}><rect x="${x}" y="${y - 25}" width="${w}" height="36" rx="7" fill="${k.fill}"${stroke}/>${text(x + w / 2, y - 2, label, { size: 14, fill: k.ink, anchor: 'middle', weight: kind === 'cheap' ? 700 : undefined })}</g>`;
  };
  const legend = Object.entries(who).map(([kind, k], index) => {
    const x = 48 + index * 420;
    const description = { cheap: 'writes all the code, several items at once', strong: 'reads: spec, review, audit', program: 'run the checks, decide what passed' }[kind];
    return `<rect x="${x}" y="70" width="22" height="22" rx="5" fill="${k.fill}"${k.stroke ? ` stroke="${k.stroke}" stroke-width="1.5"` : ''}/>
  ${text(x + 34, 87, k.label, { size: 16, fill: t.ink, weight: 700 })}
  ${text(x + 34, 110, description, { size: 13, fill: t.muted })}`;
  }).join('\n  ');
  const headers = `${text(nameX, 168, 'item', { size: 13, fill: t.faint })}
  ${text(stepX, 168, 'steps, left to right', { size: 13, fill: t.faint })}
  ${text(resultX, 168, 'evidence card', { size: 13, fill: t.faint })}`;
  const rows = items.map(([id, reached, state, why], index) => {
    const y = rowY(index);
    let x = stepX;
    const chips = steps.map(([label, kind], step) => {
      const out = chip(x, y, widths[step], kind, label, step >= reached);
      x += widths[step] + gap;
      return out;
    }).join('');
    const color = { 'merge-ready': t.teal, draft: t.amber, blocked: t.muted }[state];
    const result = `<circle cx="${resultX + 6}" cy="${y - 7}" r="6" fill="${state === 'merge-ready' ? color : 'none'}" stroke="${color}" stroke-width="1.75"/>
  ${text(resultX + 22, y - 2, state, { size: 15, fill: color, weight: state === 'merge-ready' ? 700 : undefined })}${why ? `\n  ${text(resultX + 22, y + 16, why, { size: 12, fill: t.muted })}` : ''}`;
    return `${text(nameX, y - 2, id, { size: 15, fill: t.text })}
  ${chips}
  ${result}`;
  }).join('\n  ');
  const foot = `<path d="M 48 ${H - 92} H ${W - 48}" stroke="${t.rule}"/>
  ${text(48, H - 60, 'Most of the work is the wide green step, and the cheap model does all of it. The strong model only reads.', { size: 15, fill: t.text })}
  ${text(48, H - 34, 'An item that cannot be proven stops at that step with its reason. A pull request opens for each item; nothing is merged for you.', { size: 15, fill: t.muted })}`;
  return windowFrame(t, W, H, 'mend-autopilot: who does what', `  ${legend}\n  ${headers}\n  ${rows}\n  ${foot}`,
    'Six items, each a row of steps: spec by the strong model, the code by the cheap model, checks by programs, then review and audit by the strong model. Four reach merge-ready; one stops at review as a draft after two review rounds; one is blocked at the checks because the guard refused a command.');
}

/** One item through mend-lite and mend-lite-pr, in four lanes. */
function pipeline(t) {
  const W = 1280, H = 700;
  const lanes = [
    ['You', 'ask for the change,', 'merge the PR'],
    ['Strong model', 'specs and reviews,', 'never writes code'],
    ['Cheap model', 'does the work in', 'its own worktree'],
    ['Programs', 'decide what counts', 'as verified'],
  ];
  const laneTop = 132, laneH = 124;
  const laneY = (index) => laneTop + index * laneH;
  const mid = (index) => laneY(index) + laneH / 2;
  const nodeW = 150, nodeH = 78, gap = 22;
  const col = (index) => 238 + index * (nodeW + gap) + nodeW / 2;
  const left = (c) => col(c) - nodeW / 2, right = (c) => col(c) + nodeW / 2;
  const top = (lane) => mid(lane) - nodeH / 2, bottom = (lane) => mid(lane) + nodeH / 2;
  const line = (d, color = t.faint, extra = '') => `<path d="${d}" stroke="${color}" stroke-width="1.75" fill="none" stroke-linejoin="round"${extra}/>`;
  const head = (x, y, direction, color = t.faint) => line({ right: `M ${x - 9} ${y - 5} L ${x} ${y} L ${x - 9} ${y + 5}`, up: `M ${x - 5} ${y + 9} L ${x} ${y} L ${x + 5} ${y + 9}`, down: `M ${x - 5} ${y - 9} L ${x} ${y} L ${x + 5} ${y - 9}` }[direction], color);
  const node = (c, lane, lines, { stroke = t.frame, fill = t.ink, dashed = false } = {}) => {
    const body = lines.map((value, index) => text(col(c), mid(lane) + (index - (lines.length - 1) / 2) * 22 + 5, value, { size: 15, fill, anchor: 'middle' })).join('');
    return `<rect x="${left(c)}" y="${top(lane)}" width="${nodeW}" height="${nodeH}" rx="8" fill="${t.panel}" stroke="${stroke}" stroke-width="1.5"${dashed ? ' stroke-dasharray="5 5"' : ''}/>${body}`;
  };
  const elbow = (fromC, fromLane, toC, toLane, offset = 0) => {
    const x1 = right(fromC), y1 = mid(fromLane) + offset, x2 = left(toC), y2 = mid(toLane) + offset, xm = x1 + gap / 2;
    return line(y1 === y2 ? `M ${x1} ${y1} H ${x2 - 1}` : `M ${x1} ${y1} H ${xm} V ${y2} H ${x2 - 1}`) + head(x2, y2, 'right');
  };
  const lanesSvg = lanes.map(([name, role1, role2], index) => `
  <rect x="28" y="${laneY(index) + 4}" width="${W - 56}" height="${laneH - 8}" rx="10" fill="none" stroke="${t.rule}"/>
  ${text(48, mid(index) - 12, name, { size: 17, fill: t.ink, weight: 700 })}
  ${text(48, mid(index) + 13, role1, { size: 13, fill: t.muted })}
  ${text(48, mid(index) + 31, role2, { size: 13, fill: t.muted })}`).join('');
  const phase = (fromC, toC, label) => {
    const x1 = left(fromC), x2 = right(toC);
    return `${line(`M ${x1} 106 H ${x2} M ${x1} 100 V 112 M ${x2} 100 V 112`, t.frame)}
  ${text((x1 + x2) / 2, 90, label, { size: 15, fill: t.muted, anchor: 'middle' })}`;
  };
  const body = `  ${phase(1, 3, 'mend-lite')}
  ${phase(4, 5, 'mend-lite-pr')}${lanesSvg}
  ${node(0, 0, ['your request', 'in plain words'])}
  ${node(1, 1, ['spec'])}
  ${node(2, 2, ['implement', 'and commit'], { stroke: t.sage, dashed: true })}
  ${node(3, 3, ['checks, scope', 'integrity'])}
  ${node(3, 1, ['review'])}
  ${node(4, 3, ['checks again', 'red-green'])}
  ${node(4, 1, ['auditor', 'own session'])}
  ${node(5, 3, ['evidence card'], { stroke: t.teal, fill: t.teal })}
  ${node(5, 0, ['pull request', 'you merge'])}
  ${elbow(0, 0, 1, 1)}
  ${elbow(1, 1, 2, 2)}
  ${elbow(2, 2, 3, 3)}
  ${line(`M ${col(3)} ${top(3)} V ${bottom(1) + 1}`)}${head(col(3), bottom(1), 'up')}
  ${line(`M ${left(3)} ${mid(1) + 20} H ${col(2)} V ${top(2) - 1}`, t.amber, ' stroke-dasharray="2 5" stroke-linecap="round"')}${head(col(2), top(2), 'down', t.amber)}
  ${text(col(2) + 12, mid(1) + 60, 'one fix round', { size: 13, fill: t.amber })}
  ${elbow(3, 1, 4, 1)}
  ${elbow(3, 1, 4, 3, -14)}
  ${elbow(4, 3, 5, 3)}
  ${elbow(4, 1, 5, 3, -20)}
  ${line(`M ${col(5)} ${top(3)} V ${bottom(0) + 1}`)}${head(col(5), bottom(0), 'up')}
  ${text(48, laneTop + 4 * laneH + 36, 'Any step can stop the item with its reason: blocked, or draft when its rounds are spent.', { size: 14, fill: t.muted })}`;
  return windowFrame(t, W, H, 'mend-autopilot: one item, one pull request', body,
    'How one item becomes a pull request: you ask in plain words and the lead writes the item; the strong model writes a spec; the cheap model implements and commits; programs run the checks, the scope check and the integrity scan; the strong model reviews and can send one fix round; on a clean checkout programs repeat the checks and the red-green test while an auditor drives the change in its own session; the evidence card is written and the pull request opens; you merge it.');
}

/** A real evidence card from the pilot, shortened to its answers. */
function card(t) {
  const W = 1280, H = 440;
  const rows = [
    ['checks', 'repository check (types and tests)', 'exit 0'],
    ['red-green', 'bun test tests/pagination.test.ts', 'base exit 1, head exit 0'],
    ['integrity', 'weakened tests, secrets, scope', 'nothing flagged'],
    ['review', 'strong model, 1 round', 'merge'],
    ['auditor', 'own session, 7 steps driven', 'PASS'],
    ['not verified', 'browser rendering of the invoices page', 'said on the card'],
  ];
  const rowY = (index) => 180 + index * 42;
  const body = `  ${text(48, 88, 'pagination-bounds', { size: 22, fill: t.ink, weight: 700 })}
  ${text(48, 116, 'bugfix · risk medium · owner gpt-6.1-terra · critic and auditor gpt-6-astra', { size: 14, fill: t.muted })}
  <rect x="${W - 210}" y="68" width="162" height="36" rx="18" fill="none" stroke="${t.teal}" stroke-width="1.75"/>
  ${text(W - 129, 92, 'merge-ready', { size: 15, fill: t.teal, weight: 700, anchor: 'middle' })}
  <path d="M 48 140 H ${W - 48}" stroke="${t.rule}"/>
  ${rows.map(([lane, what, result], index) => {
    const y = rowY(index);
    const open = lane === 'not verified';
    return `<circle cx="58" cy="${y - 5}" r="5" fill="${open ? 'none' : t.teal}" stroke="${open ? t.amber : t.teal}" stroke-width="1.75"/>
  ${text(78, y, lane, { size: 16, fill: t.ink })}
  ${text(250, y, what, { size: 16, fill: t.muted })}
  ${text(W - 48, y, result, { size: 16, fill: open ? t.amber : t.ink, anchor: 'end' })}`;
  }).join('\n  ')}`;
  return windowFrame(t, W, H, '.mend/evidence/pagination-bounds.json', body,
    'An evidence card from the pilot: pagination-bounds, merge-ready. Checks exit 0; the regression test failed at base and passes at head; integrity found nothing; the strong model reviewed once and would merge; the auditor passed after driving 7 steps in its own session; browser rendering was not verified, and the card says so.');
}

const files = {};
for (const [name, t] of Object.entries(THEMES)) {
  files[`logo-${name}.svg`] = logo(t);
  files[`overview-${name}.svg`] = overview(t);
  files[`pipeline-${name}.svg`] = pipeline(t);
  files[`card-${name}.svg`] = card(t);
}

const check = process.argv.includes('--check');
let drift = 0;
await fs.mkdir(OUT, { recursive: true });
const present = (await fs.readdir(OUT)).filter((name) => name.endsWith('.svg'));
for (const stale of present.filter((name) => !(name in files))) {
  if (check) { drift += 1; console.error(`render-assets: ${stale} is not produced by the templates`); }
  else await fs.rm(path.join(OUT, stale));
}
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
