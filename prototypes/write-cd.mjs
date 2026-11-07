import fs from 'node:fs';

fs.writeFileSync(
	'prototypes/icons/C-compact-close.svg',
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" fill="none">
  <g transform="translate(11, 32.75) scale(1.047)">
    <line x1="14" y1="20" x2="14" y2="38" stroke="#111111" stroke-width="7.5" stroke-linecap="round" />
    <path d="M 14 5 L 27 25 L 40 5 L 40 38" stroke="#111111" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round" />
    <g transform="translate(-10, 0)">
      <path d="M 61.5 7.3 A 17 17 0 0 1 84.7 30.5" stroke="#111111" stroke-width="7.5" stroke-linecap="round" />
      <path d="M 78.5 36.7 A 17 17 0 0 1 55.3 13.5" stroke="#111111" stroke-width="7.5" stroke-linecap="round" />
    </g>
  </g>
</svg>
`
);

fs.writeFileSync(
	'prototypes/icons/D-cut-o-only.svg',
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" fill="none">
  <g transform="translate(-8, -3) scale(1.35)">
    <path d="M 61.5 39.3 A 17 17 0 0 1 84.7 62.5" stroke="#111111" stroke-width="7.5" stroke-linecap="round" />
    <path d="M 78.5 68.7 A 17 17 0 0 1 55.3 45.5" stroke="#111111" stroke-width="7.5" stroke-linecap="round" />
  </g>
</svg>
`
);

console.log('wrote C and D');
