import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import svg2ttf from 'svg2ttf';
import ttf2woff from 'ttf2woff';

/**
 * StatusBarItem only accepts ThemeIcon fonts — cannot point at the Activity
 * Bar SVG. Build the glyph from the *same* mark + square contain-fit as
 * `media/mimo-icon.svg` (viewsContainers.activitybar icon).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'media', 'fonts');
const iconsDir = path.join(root, 'media', 'icons');
const codepoint = 0xe001;

/** media/mimo-icon.svg viewBox="8 32 82 44" */
const VB = { x: 8, y: 32, w: 82, h: 44 };
const STROKE_R = 7.5 / 2;

const SEGS = [
	{ kind: 'seg', a: [14, 52], b: [14, 70], steps: 8 },
	{ kind: 'seg', a: [14, 37], b: [27, 57], steps: 12 },
	{ kind: 'seg', a: [27, 57], b: [40, 37], steps: 12 },
	{ kind: 'seg', a: [40, 37], b: [40, 70], steps: 12 },
	{ kind: 'arc', a: [61.5, 39.3], b: [84.7, 62.5], r: 17, ccw: true, steps: 14 },
	{ kind: 'arc', a: [78.5, 68.7], b: [55.3, 45.5], r: 17, ccw: true, steps: 14 },
];

function arcPoints(x1, y1, x2, y2, radius, sweepCCW, steps) {
	const midX = (x1 + x2) / 2;
	const midY = (y1 + y2) / 2;
	const half = Math.hypot(x2 - x1, y2 - y1) / 2;
	const h = Math.sqrt(Math.max(0, radius * radius - half * half));
	const dx = x2 - x1;
	const dy = y2 - y1;
	const len = Math.hypot(dx, dy) || 1;
	const nx = -dy / len;
	const ny = dx / len;
	const cx = midX + nx * h * (sweepCCW ? 1 : -1);
	const cy = midY + ny * h * (sweepCCW ? 1 : -1);
	const a0 = Math.atan2(y1 - cy, x1 - cx);
	let delta = Math.atan2(y2 - cy, x2 - cx) - a0;
	if (sweepCCW && delta < 0) delta += Math.PI * 2;
	if (!sweepCCW && delta > 0) delta -= Math.PI * 2;
	const out = [];
	for (let i = 0; i <= steps; i++) {
		const a = a0 + (delta * i) / steps;
		out.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
	}
	return out;
}

const samples = [];
for (const s of SEGS) {
	if (s.kind === 'seg') {
		for (let i = 0; i <= s.steps; i++) {
			const t = i / s.steps;
			samples.push([s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t]);
		}
	} else {
		samples.push(...arcPoints(s.a[0], s.a[1], s.b[0], s.b[1], s.r, s.ccw, s.steps));
	}
}

/** Activity Bar square slot: contain-fit viewBox into EM×EM, then → 1000 font units. */
const EM = 24;
const fit = EM / Math.max(VB.w, VB.h);
const ox = (EM - VB.w * fit) / 2;
const oy = (EM - VB.h * fit) / 2;
const toEm = (x, y) => [ox + (x - VB.x) * fit, oy + (y - VB.y) * fit];
const FONT = 1000 / EM;
const rFont = STROKE_R * fit * FONT;

/** SVG y-down → font y-up within 0…1000 em. */
function toFont(x, y) {
	const [ex, ey] = toEm(x, y);
	return [ex * FONT, (EM - ey) * FONT];
}

function circlePath(fx, fy, r) {
	const k = 0.5522847498 * r;
	return [
		`M ${fx - r} ${fy}`,
		`C ${fx - r} ${fy + k} ${fx - k} ${fy + r} ${fx} ${fy + r}`,
		`C ${fx + k} ${fy + r} ${fx + r} ${fy + k} ${fx + r} ${fy}`,
		`C ${fx + r} ${fy - k} ${fx + k} ${fy - r} ${fx} ${fy - r}`,
		`C ${fx - k} ${fy - r} ${fx - r} ${fy - k} ${fx - r} ${fy}`,
		`Z`,
	].join(' ');
}

const d = samples
	.map(([x, y]) => {
		const [fx, fy] = toFont(x, y);
		return circlePath(fx, fy, rFont);
	})
	.join(' ');

const svgFont = `<?xml version="1.0" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg">
  <defs>
    <font id="mimo-icons" horiz-adv-x="1000">
      <font-face font-family="mimo-icons" units-per-em="1000" ascent="1000" descent="0" />
      <missing-glyph horiz-adv-x="1000" />
      <glyph unicode="&#x${codepoint.toString(16)};" glyph-name="xiaomi-mimo" horiz-adv-x="1000" d="${d}" />
    </font>
  </defs>
</svg>`;

/** Keep a square SVG twin of the Activity Bar asset for reference / future use. */
const squareSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${EM} ${EM}" width="${EM}" height="${EM}" fill="none">
  <g transform="translate(${ox},${oy}) scale(${fit}) translate(${-VB.x},${-VB.y})">
    <line x1="14" y1="52" x2="14" y2="70" stroke="#000" stroke-width="7.5" stroke-linecap="round" />
    <path d="M 14 37 L 27 57 L 40 37 L 40 70" stroke="#000" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M 61.5 39.3 A 17 17 0 0 1 84.7 62.5" stroke="#000" stroke-width="7.5" stroke-linecap="round" />
    <path d="M 78.5 68.7 A 17 17 0 0 1 55.3 45.5" stroke="#000" stroke-width="7.5" stroke-linecap="round" />
  </g>
</svg>
`;

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(iconsDir, { recursive: true });
fs.writeFileSync(path.join(iconsDir, 'xiaomi-mimo.svg'), squareSvg);

const ttf = Buffer.from(svg2ttf(svgFont, { copyright: 'Xiaomi MiMo' }).buffer);
const woff = Buffer.from(ttf2woff(ttf).buffer);
fs.writeFileSync(path.join(outDir, 'mimo-icons.ttf'), ttf);
fs.writeFileSync(path.join(outDir, 'mimo-icons.woff'), woff);
fs.writeFileSync(path.join(outDir, 'codepoints.json'), JSON.stringify({ 'xiaomi-mimo': codepoint }, null, 2));

console.log(
	`Status-bar font = Activity Bar contain-fit of mimo-icon.svg (${VB.w}×${VB.h} → ${EM}×${EM})`
);
