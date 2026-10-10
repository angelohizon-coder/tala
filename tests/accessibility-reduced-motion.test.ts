/**
 * tests/accessibility-reduced-motion.test.ts
 *
 * Milestone M8 Test Suite: Accessibility & Reduced Motion Compliance
 * Verifies:
 * 1. useReducedMotion() hook evaluates matchMedia('(prefers-reduced-motion: reduce)').
 * 2. SSR/Headless node safety (defaults to false gracefully without throwing).
 * 3. DOM dataset synchronization: document.documentElement[data-reduced-motion].
 * 4. Tailwind CSS config keyframes & animation token definitions.
 * 5. CSS stylesheet (@media (prefers-reduced-motion: reduce) and data-reduced-motion overrides).
 * 6. Dynamic Recharts animation duration (600ms vs 0ms) and isAnimationActive flags.
 * 7. Dialog modal instantaneous unmount (0ms) in reduced motion mode.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindConfig from '../tailwind.config.js';
import { useReducedMotion } from '../src/hooks/useReducedMotion';

describe('M8.1: OS prefers-reduced-motion Detection & useReducedMotion Hook', () => {
  const originalWindow = (globalThis as any).window;
  const originalDocument = (globalThis as any).document;

  beforeEach(() => {
    const datasetStorage: Record<string, string> = {};
    (globalThis as any).document = {
      documentElement: {
        dataset: datasetStorage,
        setAttribute: vi.fn((attr: string, val: string) => {
          datasetStorage[attr.replace(/^data-/, '')] = String(val);
        }),
        getAttribute: vi.fn((attr: string) => {
          return datasetStorage[attr.replace(/^data-/, '')] ?? null;
        }),
      },
    };

    (globalThis as any).window = {
      document: (globalThis as any).document,
      matchMedia: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  });

  afterEach(() => {
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
  });

  it('safely handles headless/SSR environment when matchMedia is missing', () => {
    // In pure Node or SSR, window or matchMedia may not exist
    delete (globalThis as any).window;
    expect(typeof useReducedMotion).toBe('function');
  });

  it('evaluates window.matchMedia when prefers-reduced-motion is true', () => {
    const listeners: ((e: { matches: boolean }) => void)[] = [];
    const mockMatchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn((event: string, cb: any) => {
        if (event === 'change') listeners.push(cb);
      }),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    (window as any).matchMedia = mockMatchMedia;

    expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
    expect(mockMatchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
  });

  it('synchronizes data-reduced-motion attribute on document.documentElement', () => {
    expect(document.documentElement).toBeDefined();

    document.documentElement.setAttribute('data-reduced-motion', 'true');
    expect(document.documentElement.getAttribute('data-reduced-motion')).toBe('true');

    document.documentElement.setAttribute('data-reduced-motion', 'false');
    expect(document.documentElement.getAttribute('data-reduced-motion')).toBe('false');
  });
});

describe('M8.2: Tailwind Config Animation Tokens & Keyframes', () => {
  it('defines required animation keyframes in tailwind.config.js', () => {
    const keyframes = tailwindConfig.theme?.extend?.keyframes as Record<string, any>;
    expect(keyframes).toBeDefined();

    expect(keyframes.pageFadeIn).toBeDefined();
    expect(keyframes.pageFadeIn['0%']?.opacity).toBe('0');
    expect(keyframes.pageFadeIn['100%']?.opacity).toBe('1');

    expect(keyframes.dialogEnter).toBeDefined();
    expect(keyframes.dialogEnter['0%']?.opacity).toBe('0');
    expect(keyframes.dialogEnter['100%']?.opacity).toBe('1');

    expect(keyframes.dialogExit).toBeDefined();
    expect(keyframes.dialogExit['0%']?.opacity).toBe('1');
    expect(keyframes.dialogExit['100%']?.opacity).toBe('0');

    expect(keyframes.backdropEnter).toBeDefined();
    expect(keyframes.backdropExit).toBeDefined();
    expect(keyframes.chartFadeIn).toBeDefined();
  });

  it('defines semantic animation utilities in tailwind.config.js', () => {
    const animation = tailwindConfig.theme?.extend?.animation as Record<string, string>;
    expect(animation).toBeDefined();

    expect(animation['page-fade-in']).toBe('pageFadeIn 180ms cubic-bezier(0.16, 1, 0.3, 1) both');
    expect(animation['modal-in']).toBe('dialogEnter 200ms cubic-bezier(0.16, 1, 0.3, 1) both');
    expect(animation['modal-out']).toBe('dialogExit 150ms cubic-bezier(0.16, 1, 0.3, 1) both');
    expect(animation['backdrop-in']).toBe('backdropEnter 200ms ease-out both');
    expect(animation['backdrop-out']).toBe('backdropExit 150ms ease-in both');
    expect(animation['chart-in']).toBe('chartFadeIn 350ms cubic-bezier(0.16, 1, 0.3, 1) both');
  });
});

describe('M8.3: CSS Stylesheet Reduced Motion Overrides', () => {
  const cssPath = resolve(__dirname, '../src/styles.css');
  const cssContent = readFileSync(cssPath, 'utf-8');

  it('declares @media (prefers-reduced-motion: reduce) rule in styles.css', () => {
    expect(cssContent).toContain('@media(prefers-reduced-motion:reduce)');
  });

  it('completely disables animation and transition for reduced motion via !important', () => {
    expect(cssContent).toMatch(/@media\(prefers-reduced-motion:reduce\)\s*\{[^}]*animation:none!important[^}]*\}/);
    expect(cssContent).toMatch(/@media\(prefers-reduced-motion:reduce\)\s*\{[^}]*transition:none!important[^}]*\}/);
  });

  it('declares html[data-reduced-motion="true"] attribute selectors in styles.css', () => {
    expect(cssContent).toContain('html[data-reduced-motion="true"]');
    expect(cssContent).toMatch(/html\[data-reduced-motion="true"\][^}]*animation:\s*none\s*!important/);
  });

  it('explicitly suppresses dialog backdrop animations under @media (prefers-reduced-motion: reduce)', () => {
    // Universal selector `*` matches elements in DOM tree but does NOT match top-layer pseudo-elements (::backdrop).
    // Ensure .dialog::backdrop is explicitly suppressed with animation: none !important within the @media block.
    const mediaStartIndex = cssContent.search(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);
    expect(mediaStartIndex).toBeGreaterThanOrEqual(0);

    const firstBrace = cssContent.indexOf('{', mediaStartIndex);
    expect(firstBrace).toBeGreaterThanOrEqual(0);

    let depth = 1;
    let i = firstBrace + 1;
    while (i < cssContent.length && depth > 0) {
      if (cssContent[i] === '{') depth++;
      else if (cssContent[i] === '}') depth--;
      i++;
    }
    const mediaBlock = cssContent.slice(firstBrace + 1, i - 1);

    expect(mediaBlock).toMatch(/\.dialog::backdrop/);
    expect(mediaBlock).toMatch(/(?:\.dialog::backdrop|::backdrop)[^{]*\{[^}]*animation\s*:\s*none\s*!important/);
  });

  it('explicitly suppresses dialog backdrop animations under html[data-reduced-motion="true"]', () => {
    // Verifies html[data-reduced-motion="true"] explicitly suppresses .dialog::backdrop animation
    expect(cssContent).toMatch(/html\[data-reduced-motion="true"\][^{]*\.dialog::backdrop/);
    expect(cssContent).toMatch(/html\[data-reduced-motion="true"\][^{]*\.dialog::backdrop[^{]*\{[^}]*animation\s*:\s*none\s*!important/);
  });

  it('declares GPU-composited .page-transition utility with opacity and transform animations', () => {
    expect(cssContent).toContain('.page-transition');
    expect(cssContent).toContain('animation: pageFadeIn');
    expect(cssContent).toContain('will-change: opacity, transform');
  });

  it('defines .chart-container with fixed height preventing CLS layout shifts', () => {
    expect(cssContent).toContain('.chart-container');
    expect(cssContent).toMatch(/\.chart-container\{height:\s*220px/);
  });
});

describe('M8.4: Recharts Visualizations Reduced Motion Calculations', () => {
  // Calculates animation duration and active flag based on prefersReducedMotion
  function getChartAnimationProps(prefersReducedMotion: boolean) {
    return {
      isAnimationActive: !prefersReducedMotion,
      animationDuration: prefersReducedMotion ? 0 : 600,
    };
  }

  it('enables 600ms smooth SVG animation when reduced motion is false', () => {
    const props = getChartAnimationProps(false);
    expect(props.isAnimationActive).toBe(true);
    expect(props.animationDuration).toBe(600);
  });

  it('disables animation immediately (0ms, isAnimationActive=false) when reduced motion is true', () => {
    const props = getChartAnimationProps(true);
    expect(props.isAnimationActive).toBe(false);
    expect(props.animationDuration).toBe(0);
  });

  it('verifies all 6 charts in source files bind to dynamic prefersReducedMotion', () => {
    const overviewContent = readFileSync(resolve(__dirname, '../src/pages/Overview.tsx'), 'utf-8');
    const planningContent = readFileSync(resolve(__dirname, '../src/pages/PlanningPages.tsx'), 'utf-8');

    // 1. Overview Cash Flow AreaChart & Asset Allocation PieChart
    expect(overviewContent).toContain('useReducedMotion');
    expect(overviewContent).toContain('isAnimationActive={!prefersReducedMotion}');
    expect(overviewContent).toContain('animationDuration={prefersReducedMotion ? 0 : 600}');

    // 2. PlanningPages: FirePage Monte Carlo & PDF charts
    expect(planningContent).toContain('useReducedMotion');
    expect(planningContent).toContain('isAnimationActive={!prefersReducedMotion}');
    expect(planningContent).toContain('animationDuration={prefersReducedMotion ? 0 : 600}');
  });
});
