import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const iconsDir = path.join(root, 'icons');
const outDir = path.join(root, 'preview');
fs.mkdirSync(outDir, { recursive: true });

const variants = [
	{ id: 'A', file: 'A-faithful-wide.svg', title: 'A faithful wide' },
	{ id: 'B', file: 'B-square-letterbox.svg', title: 'B square letterbox' },
	{ id: 'C', file: 'C-compact-close.svg', title: 'C compact close' },
	{ id: 'D', file: 'D-cut-o-only.svg', title: 'D cut-O only' },
	{ id: 'E', file: 'E-optical-16.svg', title: 'E optical 16px' },
];

function raster(svg, size) {
	const resvg = new Resvg(svg, {
		fitTo: { mode: 'width', value: size },
		background: 'transparent',
	});
	return resvg.render().asPng();
}

function wrapOnBg(iconSvg, size, bg, fg) {
	const colored = iconSvg.replaceAll('#111111', fg).replaceAll('#FFFFFF', fg).replaceAll('#FCFCFE', fg);
	const png = raster(colored, size);
	// Compose onto solid bg via another SVG embedding the raster as... simpler: redraw SVG on bg rect
	const withBg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="100%" height="100%" fill="${bg}"/>
  <image href="data:image/png;base64,${Buffer.from(png).toString('base64')}" width="${size}" height="${size}" />
</svg>`;
	return raster(withBg, size);
}

function pillMock(iconSvg, fg, bg, pill, labelColor) {
	const iconSize = 16;
	const iconPng = raster(iconSvg.replaceAll('#111111', fg).replaceAll('#FFFFFF', fg).replaceAll('#FCFCFE', fg), iconSize);
	const w = 220;
	const h = 48;
	const svg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="100%" height="100%" fill="${bg}"/>
  <rect x="16" y="10" rx="8" ry="8" width="168" height="28" fill="${pill}"/>
  <image x="24" y="16" width="16" height="16" href="data:image/png;base64,${Buffer.from(iconPng).toString('base64')}"/>
  <text x="46" y="29" font-family="Segoe UI, sans-serif" font-size="13" fill="${labelColor}">Xiaomi MiMo</text>
</svg>`;
	return raster(svg, w);
}

// Board: for each variant — large 128, sizes 16/24/32, light pill, dark pill
const cellW = 260;
const cellH = 310;
const cols = variants.length;
const rows = 1;
const pad = 24;
const boardW = pad * 2 + cols * cellW;
const boardH = pad * 2 + rows * cellH + 40;

const parts = [];
parts.push(`<rect width="100%" height="100%" fill="#F4F4F4"/>`);
parts.push(`<text x="${pad}" y="28" font-family="Segoe UI,sans-serif" font-size="16" font-weight="600" fill="#111">MiMo icon prototypes (not applied yet)</text>`);

for (let i = 0; i < variants.length; i++) {
	const v = variants[i];
	const svg = fs.readFileSync(path.join(iconsDir, v.file), 'utf8');
	const x0 = pad + i * cellW;
	const y0 = pad + 40;

	const big = wrapOnBg(svg, 96, '#FFFFFF', '#111111');
	const s16 = wrapOnBg(svg, 16, '#FFFFFF', '#111111');
	const s24 = wrapOnBg(svg, 24, '#FFFFFF', '#111111');
	const s32 = wrapOnBg(svg, 32, '#FFFFFF', '#111111');
	const s16d = wrapOnBg(svg, 16, '#1E1E1E', '#FCFCFE');
	const s24d = wrapOnBg(svg, 24, '#1E1E1E', '#FCFCFE');
	const pillL = pillMock(svg, '#111111', '#FFFFFF', '#E8E8E8', '#111111');
	const pillD = pillMock(svg, '#FCFCFE', '#1E1E1E', '#3C3C3C', '#F0F0F0');

	const embeds = [
		{ png: big, x: x0 + 20, y: y0 + 28, w: 96, h: 96 },
		{ png: s16, x: x0 + 140, y: y0 + 28, w: 16, h: 16 },
		{ png: s24, x: x0 + 170, y: y0 + 28, w: 24, h: 24 },
		{ png: s32, x: x0 + 206, y: y0 + 28, w: 32, h: 32 },
		{ png: s16d, x: x0 + 140, y: y0 + 72, w: 16, h: 16 },
		{ png: s24d, x: x0 + 170, y: y0 + 72, w: 24, h: 24 },
		{ png: pillL, x: x0 + 10, y: y0 + 140, w: 220, h: 48 },
		{ png: pillD, x: x0 + 10, y: y0 + 198, w: 220, h: 48 },
	];

	parts.push(`<rect x="${x0}" y="${y0}" width="${cellW - 12}" height="${cellH - 20}" rx="10" fill="#FFFFFF" stroke="#DDD"/>`);
	parts.push(`<text x="${x0 + 14}" y="${y0 + 20}" font-family="Segoe UI,sans-serif" font-size="13" font-weight="600" fill="#111">${v.title}</text>`);
	parts.push(`<text x="${x0 + 140}" y="${y0 + 24}" font-family="Segoe UI,sans-serif" font-size="10" fill="#666">16/24/32</text>`);

	for (const e of embeds) {
		parts.push(
			`<image x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" href="data:image/png;base64,${Buffer.from(e.png).toString('base64')}"/>`
		);
	}

	// Also write individual exports
	fs.writeFileSync(path.join(outDir, `${v.id}-128-light.png`), wrapOnBg(svg, 128, '#FFFFFF', '#111111'));
	fs.writeFileSync(path.join(outDir, `${v.id}-16-light.png`), wrapOnBg(svg, 16, '#FFFFFF', '#111111'));
	fs.writeFileSync(path.join(outDir, `${v.id}-16-dark.png`), wrapOnBg(svg, 16, '#1E1E1E', '#FCFCFE'));
	fs.writeFileSync(path.join(outDir, `${v.id}-pill-light.png`), pillL);
	fs.writeFileSync(path.join(outDir, `${v.id}-pill-dark.png`), pillD);
}

const boardSvg = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${boardW}" height="${boardH}" viewBox="0 0 ${boardW} ${boardH}">
${parts.join('\n')}
</svg>`;

const boardPng = raster(boardSvg, boardW);
const boardPath = path.join(outDir, 'board.png');
fs.writeFileSync(boardPath, boardPng);
console.log(`Wrote ${boardPath}`);
