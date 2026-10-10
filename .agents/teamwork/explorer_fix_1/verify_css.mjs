import postcss from 'postcss';
import tailwind from 'tailwindcss';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve('e:/Visual Studio Code/tala');
const stylesPath = resolve(projectRoot, 'src/styles.css');
let originalCss = readFileSync(stylesPath, 'utf-8');

// Proposed replacements
const originalLine12 = '@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important;scroll-behavior:auto!important}.page-transition,.dialog,.dialog.dialog-closing,.chart-container{animation:none!important;transform:none!important}}';
const proposedLine12 = '@media(prefers-reduced-motion:reduce){*,*::before,*::after,::backdrop,.dialog::backdrop,.dialog.dialog-closing::backdrop{transition:none!important;animation:none!important;scroll-behavior:auto!important}.page-transition,.dialog,.dialog.dialog-closing,.dialog::backdrop,.dialog.dialog-closing::backdrop,::backdrop,.chart-container{animation:none!important;transform:none!important;transition:none!important}}';

const originalLines62_76 = `html[data-reduced-motion="true"] *,
html[data-reduced-motion="true"] *::before,
html[data-reduced-motion="true"] *::after {
  transition: none !important;
  animation: none !important;
  scroll-behavior: auto !important;
}

html[data-reduced-motion="true"] .page-transition,
html[data-reduced-motion="true"] .dialog,
html[data-reduced-motion="true"] .dialog.dialog-closing,
html[data-reduced-motion="true"] .chart-container {
  animation: none !important;
  transform: none !important;
}`;

const proposedLines62_76 = `html[data-reduced-motion="true"] *,
html[data-reduced-motion="true"] *::before,
html[data-reduced-motion="true"] *::after,
html[data-reduced-motion="true"] ::backdrop,
html[data-reduced-motion="true"] .dialog::backdrop,
html[data-reduced-motion="true"] .dialog.dialog-closing::backdrop {
  transition: none !important;
  animation: none !important;
  scroll-behavior: auto !important;
}

html[data-reduced-motion="true"] .page-transition,
html[data-reduced-motion="true"] .dialog,
html[data-reduced-motion="true"] .dialog.dialog-closing,
html[data-reduced-motion="true"] .dialog::backdrop,
html[data-reduced-motion="true"] .dialog.dialog-closing::backdrop,
html[data-reduced-motion="true"] ::backdrop,
html[data-reduced-motion="true"] .chart-container {
  animation: none !important;
  transform: none !important;
  transition: none !important;
}`;

const patchedCss = originalCss
  .replace(originalLine12, proposedLine12)
  .replace(originalLines62_76, proposedLines62_76);

console.log('Original replaced line 12:', patchedCss.includes(proposedLine12));
console.log('Original replaced lines 62-76:', patchedCss.includes(proposedLines62_76));

// Test against accessibility regex
console.log('Check accessibility test media anim:', /@media\(prefers-reduced-motion:reduce\)\s*\{[^}]*animation:none!important[^}]*\}/.test(patchedCss));
console.log('Check accessibility test media trans:', /@media\(prefers-reduced-motion:reduce\)\s*\{[^}]*transition:none!important[^}]*\}/.test(patchedCss));
console.log('Check accessibility test data-reduced-motion:', /html\[data-reduced-motion="true"\][^}]*animation:\s*none\s*!important/.test(patchedCss));

// Test against challenger test logic
const reducedMotionBlockMatch = patchedCss.match(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{([^}]+)\}/);
const reducedMotionBlock = reducedMotionBlockMatch ? reducedMotionBlockMatch[1] : '';
const dataReducedMotionRules = patchedCss.split('html[data-reduced-motion="true"]').slice(1).join(' ');

console.log('Challenger backdropCoveredInMedia:', reducedMotionBlock.includes('backdrop'));
console.log('Challenger backdropCoveredInDataAttr:', dataReducedMotionRules.includes('backdrop'));

// Run PostCSS
postcss([tailwind(resolve(projectRoot, 'tailwind.config.js'))]).process(patchedCss, { from: stylesPath }).then(res => {
  console.log('PostCSS compilation SUCCESS, processed CSS size:', res.css.length);
}).catch(err => {
  console.error('PostCSS compilation ERROR:', err);
});
