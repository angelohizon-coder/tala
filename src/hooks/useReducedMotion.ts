import { useState, useEffect } from 'react';

/**
 * Hook detecting user's OS prefers-reduced-motion setting.
 * SSR-safe, Node-test safe, and reactively synchronizes
 * document.documentElement[data-reduced-motion].
 */
export function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    const updateMotion = (matches: boolean) => {
      setReducedMotion(matches);
      if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.setAttribute('data-reduced-motion', String(matches));
      }
    };

    // Initial attribute sync
    updateMotion(mediaQuery.matches);

    const handleChange = (event: MediaQueryListEvent | { matches: boolean }) => {
      updateMotion(event.matches);
    };

    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', handleChange as EventListener);
    } else if ('addListener' in mediaQuery) {
      (mediaQuery as { addListener: (cb: (e: { matches: boolean }) => void) => void }).addListener(handleChange);
    }

    return () => {
      if (mediaQuery.removeEventListener) {
        mediaQuery.removeEventListener('change', handleChange as EventListener);
      } else if ('removeListener' in mediaQuery) {
        (mediaQuery as { removeListener: (cb: (e: { matches: boolean }) => void) => void }).removeListener(handleChange);
      }
    };
  }, []);

  return reducedMotion;
}
