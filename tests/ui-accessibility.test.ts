/**
 * tests/ui-accessibility.test.ts
 *
 * Milestone M6 Test Suite: UI, UX & Accessibility Refactoring (Requirement R6)
 * Verifies:
 * 1. WCAG 2.1/2.2 AA Color Contrast Ratios (Tala Forest Green #173c34, remediated #4f5e58)
 * 2. Honest Empty States (Zero fake/demo/simulated data across core views)
 * 3. Accessible Gain/Loss Indicators (WCAG 1.4.1: Unary signs, directional icons, sr-only announcements)
 * 4. Visible Keyboard Focus Styling (focus-visible rings and 3:1 contrast focus appearance)
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import tailwindConfig from '../tailwind.config.js';
import { HONEST_EMPTY_STATES, EmptyState } from '../src/components/EmptyState';
import { TrendIndicator, renderFinancialDelta } from '../src/components/TrendIndicator';

/**
 * WCAG 2.1 relative luminance calculation
 */
function getRelativeLuminance(hex: string): number {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;

  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * WCAG 2.1 contrast ratio between two hex colors
 */
function getContrastRatio(hex1: string, hex2: string): number {
  const l1 = getRelativeLuminance(hex1);
  const l2 = getRelativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('M6.1: Tailwind CSS Brand Theme & WCAG Contrast Compliance', () => {
  const theme = {
    brandForest: '#173c34',       // Canonical Tala Forest Green
    textSecondary: '#4f5e58',     // Remediated secondary/neutral text
    legacyMuted: '#7a8782',       // Old legacy muted text (failed contrast)
    financialGain: '#1f664a',     // Remediated gain text
    financialLoss: '#9c3832',     // Remediated loss text
    surfaceBg: '#f5f6f8',         // Application surface background
    cardBg: '#ffffff',            // Card container background
  };

  it('configures Tala Forest Green (#173c34) as brand-900 and tala-green in Tailwind config', () => {
    const colors = tailwindConfig.theme?.extend?.colors as any;
    expect(colors).toBeDefined();
    expect(colors.brand?.[900]?.toLowerCase()).toBe('#173c34');
    expect(colors['tala-green']?.toLowerCase()).toBe('#173c34');
    expect(colors.financial?.gain?.toLowerCase()).toBe('#1f664a');
    expect(colors.financial?.loss?.toLowerCase()).toBe('#9c3832');
    expect(colors.financial?.neutral?.toLowerCase()).toBe('#4f5e58');
  });

  it('validates Tala Forest Green (#173c34) on card background (#ffffff) passes WCAG AAA (>= 7.0:1)', () => {
    const ratio = getContrastRatio(theme.brandForest, theme.cardBg);
    expect(ratio).toBeGreaterThanOrEqual(7.0);
    expect(ratio).toBeGreaterThan(12.0); // High-contrast brand green
  });

  it('validates remediated secondary text (#4f5e58) meets WCAG AA (>= 4.5:1) on surface (#f5f6f8)', () => {
    const ratio = getContrastRatio(theme.textSecondary, theme.surfaceBg);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(ratio).toBeGreaterThan(6.0); // Solid margin above 4.5:1
  });

  it('validates remediated secondary text (#4f5e58) meets WCAG AA (>= 4.5:1) on card (#ffffff)', () => {
    const ratio = getContrastRatio(theme.textSecondary, theme.cardBg);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(ratio).toBeGreaterThan(6.5);
  });

  it('verifies that old muted text (#7a8782) failed WCAG AA (< 4.5:1), proving remediation is essential', () => {
    const oldRatio = getContrastRatio(theme.legacyMuted, theme.surfaceBg);
    expect(oldRatio).toBeLessThan(4.5);
    expect(oldRatio).toBeCloseTo(3.42, 1);
  });

  it('validates financial gain text (#1f664a) meets WCAG AA (>= 4.5:1) on card (#ffffff)', () => {
    const ratio = getContrastRatio(theme.financialGain, theme.cardBg);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(ratio).toBeGreaterThan(6.5);
  });

  it('validates financial loss text (#9c3832) meets WCAG AA (>= 4.5:1) on card (#ffffff)', () => {
    const ratio = getContrastRatio(theme.financialLoss, theme.cardBg);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(ratio).toBeGreaterThan(6.5);
  });
});

describe('M6.2: Honest Empty States (Zero Simulated or Fake Demo Data)', () => {
  const CORE_VIEWS = ['accounts', 'transactions', 'investments', 'budgets', 'fire', 'watchlist'] as const;

  it('defines honest empty states across all 6 core views', () => {
    for (const view of CORE_VIEWS) {
      const preset = HONEST_EMPTY_STATES[view];
      expect(preset).toBeDefined();
      expect(preset.count).toBe(0);
      expect(preset.hasMockData).toBe(false);
      expect(preset.title.length).toBeGreaterThan(5);
      expect(preset.description.length).toBeGreaterThan(10);
      expect(preset.actionLabel).toBeDefined();
    }
  });

  it('strictly contains zero fake balances, simulated account values, or mock transactions in text', () => {
    const prohibitedTerms = [/₱\s*\d+/, /\$\s*\d+/, /sample balance/i, /demo account/i, /simulated/i, /placeholder data/i];

    for (const view of CORE_VIEWS) {
      const preset = HONEST_EMPTY_STATES[view];
      for (const pattern of prohibitedTerms) {
        expect(preset.title).not.toMatch(pattern);
        expect(preset.description).not.toMatch(pattern);
      }
    }
  });

  it('renders reusable EmptyState component with honest preset when view prop is supplied', () => {
    const html = renderToStaticMarkup(React.createElement(EmptyState, { view: 'accounts' }));
    expect(html).toContain('Start with an account');
    expect(html).toContain('Add your actual bank, wallet, cash or loan balance');
    expect(html).toContain('role="region"');
    expect(html).toContain('empty-state');
  });

  it('renders custom actions and preserves accessibility region attributes', () => {
    const customAction = React.createElement('button', { className: 'button primary' }, 'Add your first account');
    const html = renderToStaticMarkup(
      React.createElement(EmptyState, {
        view: 'transactions',
        action: customAction,
      })
    );
    expect(html).toContain('Your story starts with a transaction');
    expect(html).toContain('Add your first account');
    expect(html).not.toMatch(/\$|\u20B1\s*\d+/); // No fake currency
  });
});

describe('M6.3: Accessible Gain/Loss Indicators (WCAG 1.4.1 Non-Color Reliance)', () => {
  it('renderFinancialDelta provides unary sign, directional icon, and sr-only text for gains', () => {
    const delta = renderFinancialDelta(150000, 'PHP');
    expect(delta.isPositive).toBe(true);
    expect(delta.isNegative).toBe(false);
    expect(delta.hasSign).toBe(true);
    expect(delta.text.startsWith('+')).toBe(true);
    expect(delta.icon).toBe('ArrowUpRight');
    expect(delta.srAnnouncement).toContain('Gain of 150000');
  });

  it('renderFinancialDelta provides unary sign, directional icon, and sr-only text for losses', () => {
    const delta = renderFinancialDelta(-75000, 'PHP');
    expect(delta.isPositive).toBe(false);
    expect(delta.isNegative).toBe(true);
    expect(delta.hasSign).toBe(true);
    expect(delta.text.startsWith('-')).toBe(true);
    expect(delta.icon).toBe('ArrowDownRight');
    expect(delta.srAnnouncement).toContain('Loss of 75000');
  });

  it('renderFinancialDelta handles neutral zero without misleading directional signs', () => {
    const delta = renderFinancialDelta(0, 'PHP');
    expect(delta.isPositive).toBe(false);
    expect(delta.isNegative).toBe(false);
    expect(delta.hasSign).toBe(false);
    expect(delta.icon).toBe('Minus');
    expect(delta.srAnnouncement).toBe('No change');
  });

  it('renders TrendIndicator component with complete non-color cues for positive gain', () => {
    const html = renderToStaticMarkup(
      React.createElement(TrendIndicator, {
        value: 50000, // +PHP 500.00
        currency: 'PHP',
        isMinor: true,
      })
    );
    // 1. Explicit unary plus sign
    expect(html).toContain('+');
    // 2. Directional visual arrow icon
    expect(html).toContain('lucide-arrow-up-right');
    // 3. Screen reader text
    expect(html).toContain('sr-only');
    expect(html).toContain('Gain of 50000');
    // 4. Semantic accessible text color
    expect(html).toContain('text-financial-gain');
    expect(html).toContain('data-trend="gain"');
  });

  it('renders TrendIndicator component with complete non-color cues for negative loss', () => {
    const html = renderToStaticMarkup(
      React.createElement(TrendIndicator, {
        value: -25000, // -PHP 250.00
        currency: 'PHP',
        isMinor: true,
      })
    );
    // 1. Explicit unary minus sign
    expect(html).toContain('-');
    // 2. Directional visual arrow icon
    expect(html).toContain('lucide-arrow-down-right');
    // 3. Screen reader text
    expect(html).toContain('sr-only');
    expect(html).toContain('Loss of 25000');
    // 4. Semantic accessible text color
    expect(html).toContain('text-financial-loss');
    expect(html).toContain('data-trend="loss"');
  });

  it('renders percentage delta correctly with non-color accessibility indicators', () => {
    const html = renderToStaticMarkup(
      React.createElement(TrendIndicator, {
        value: 4.25,
        isPercent: true,
      })
    );
    expect(html).toContain('+4.25%');
    expect(html).toContain('lucide-arrow-up-right');
    expect(html).toContain('Gain of 4.25%');
  });

  it('renders em-dash for null or undefined delta values', () => {
    const htmlNull = renderToStaticMarkup(React.createElement(TrendIndicator, { value: null }));
    expect(htmlNull).toContain('—');
    expect(htmlNull).toContain('text-financial-neutral');

    const htmlUndefined = renderToStaticMarkup(React.createElement(TrendIndicator, { value: undefined }));
    expect(htmlUndefined).toContain('—');
  });
});

describe('M6.4: Visible Keyboard Focus Styles & Appearance (WCAG 2.4.7 & 2.4.11)', () => {
  it('defines visible high-contrast keyboard focus tokens in Tailwind configuration', () => {
    const colors = tailwindConfig.theme?.extend?.colors as any;
    expect(colors.ring).toBe('#173c34');
    expect(colors['tala-green']).toBe('#173c34');
    expect(colors.brand?.[900]).toBe('#173c34');
  });

  it('ensures focus ring color (#173c34) meets WCAG 2.2 3:1 focus appearance contrast minimum', () => {
    const ratioOnSurface = getContrastRatio('#173c34', '#f5f6f8');
    expect(ratioOnSurface).toBeGreaterThanOrEqual(3.0);
    expect(ratioOnSurface).toBeGreaterThanOrEqual(7.0); // Actually achieves > 10:1

    const ratioOnCard = getContrastRatio('#173c34', '#ffffff');
    expect(ratioOnCard).toBeGreaterThanOrEqual(3.0);
  });
});
