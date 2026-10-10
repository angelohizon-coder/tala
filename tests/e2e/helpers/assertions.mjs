/**
 * assertions.mjs
 * Custom assertion utilities for Tala E2E & Acceptance test suites.
 */
import assert from 'node:assert/strict';

/**
 * Asserts that two amounts in integer minor units are equal.
 */
export function assertMinorEqual(actual, expected, message = '') {
  assert.equal(
    Number.isSafeInteger(actual),
    true,
    `Expected actual (${actual}) to be a safe integer minor unit. ${message}`
  );
  assert.equal(
    Number.isSafeInteger(expected),
    true,
    `Expected expected (${expected}) to be a safe integer minor unit. ${message}`
  );
  assert.equal(actual, expected, message);
}

/**
 * Validates that an object conforms to the NormalizedMarketQuote schema.
 */
export function assertNormalizedMarketQuote(quote) {
  assert.ok(quote, 'Quote must not be null or undefined');
  assert.equal(typeof quote.symbol, 'string', 'Symbol must be a string');
  assert.ok(quote.symbol.length > 0, 'Symbol must not be empty');
  assert.equal(typeof quote.price, 'number', 'Price must be a number');
  assert.ok(Number.isFinite(quote.price), 'Price must be finite');
  assert.ok(quote.price > 0, 'Price must be strictly positive (never zero or negative)');
  assert.equal(typeof quote.currency, 'string', 'Currency must be a string');
  assert.equal(typeof quote.timestamp, 'number', 'Timestamp must be a number');
  assert.equal(typeof quote.asOf, 'string', 'asOf must be an ISO string');
  assert.ok(!Number.isNaN(Date.parse(quote.asOf)), 'asOf must be a parseable ISO date');
  assert.ok(['yahoo', 'yahoo_v8', 'fcs', 'fcs_api', 'cache', 'firestore_cache'].includes(quote.provider), `Provider ${quote.provider} invalid`);
  assert.ok(['realtime', 'live', 'delayed', 'eod', 'stale'].includes(quote.freshness), `Freshness ${quote.freshness} invalid`);
  assert.equal(typeof quote.isStale, 'boolean', 'isStale must be a boolean');
}

/**
 * Computes WCAG 2.1 relative luminance for an sRGB hex color.
 */
export function getRelativeLuminance(hex) {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;

  const toLinear = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * Computes WCAG 2.1 contrast ratio between two hex colors.
 */
export function getContrastRatio(hex1, hex2) {
  const l1 = getRelativeLuminance(hex1);
  const l2 = getRelativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Asserts that the contrast between foreground and background meets WCAG AA (4.5:1).
 */
export function assertWcagAaContrast(fgHex, bgHex, minRatio = 4.5, context = '') {
  const ratio = getContrastRatio(fgHex, bgHex);
  assert.ok(
    ratio >= minRatio,
    `WCAG Contrast violation for ${context}: ${fgHex} on ${bgHex} ratio is ${ratio.toFixed(2)}:1 (minimum ${minRatio}:1 required)`
  );
}
