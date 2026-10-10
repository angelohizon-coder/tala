import React from 'react';
import { ArrowUpRight, ArrowDownRight, Minus } from 'lucide-react';
import { formatMoney } from '../ui/shared';

export interface FinancialDeltaData {
  text: string;
  hasSign: boolean;
  icon: 'ArrowUpRight' | 'ArrowDownRight' | 'Minus';
  srAnnouncement: string;
  isPositive: boolean;
  isNegative: boolean;
}

/**
 * Standard specification helper for rendering financial deltas (WCAG 1.4.1).
 * Never relies on color alone — provides unary sign, directional icon, and screen reader text.
 */
export function renderFinancialDelta(amount: number, currency = 'PHP'): FinancialDeltaData {
  const isPositive = amount > 0;
  const isNegative = amount < 0;
  return {
    text: `${isPositive ? '+' : isNegative ? '-' : ''}${Math.abs(amount / 100).toFixed(2)} ${currency}`,
    hasSign: isPositive || isNegative,
    icon: isPositive ? 'ArrowUpRight' : isNegative ? 'ArrowDownRight' : 'Minus',
    srAnnouncement: isPositive
      ? `Gain of ${amount}`
      : isNegative
        ? `Loss of ${Math.abs(amount)}`
        : 'No change',
    isPositive,
    isNegative,
  };
}

export interface TrendIndicatorProps {
  /** Numeric delta value or minor units amount */
  value?: number | null;
  amount?: number | null;
  currency?: string;
  /** Whether the amount is in minor units (default: true) */
  isMinor?: boolean;
  /** Whether this represents a percentage change (e.g. +2.50%) */
  isPercent?: boolean;
  showZero?: boolean;
  className?: string;
}

/**
 * Accessible Trend & Gain/Loss Indicator component (WCAG 1.4.1 & 1.4.3 compliant).
 * Guarantees that color is never the only means of conveying positive/negative status:
 * 1. Explicit unary sign (+ or -)
 * 2. Visual directional arrow icon (ArrowUpRight or ArrowDownRight)
 * 3. Screen-reader only announcement ("Gain of ...", "Loss of ...")
 * 4. High-contrast WCAG AA accessible text color (>= 4.5:1 ratio)
 */
export function TrendIndicator({
  value,
  amount,
  currency = 'PHP',
  isMinor = true,
  isPercent = false,
  showZero = true,
  className = '',
}: TrendIndicatorProps) {
  const val = value !== undefined ? value : amount;

  if (val === null || val === undefined || !Number.isFinite(val)) {
    return <span className={`text-financial-neutral font-mono tabular-nums ${className}`}>—</span>;
  }

  if (val === 0 && !showZero) {
    return <span className={`text-financial-neutral font-mono tabular-nums ${className}`}>—</span>;
  }

  const isPositive = val > 0;
  const isNegative = val < 0;
  const isZero = val === 0;

  // 1. Explicit unary sign
  const sign = isPositive ? '+' : isNegative ? '-' : '';

  // 2. Formatted display string
  let displayString = '';
  if (isPercent) {
    displayString = `${sign}${Math.abs(val).toFixed(2)}%`;
  } else if (isMinor) {
    const formattedMagnitude = formatMoney(Math.abs(val), currency);
    displayString = `${sign}${formattedMagnitude}`;
  } else {
    displayString = `${sign}${Math.abs(val).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} ${currency}`;
  }

  // 3. Screen reader text announcement
  const magnitudeText = isPercent
    ? `${Math.abs(val).toFixed(2)}%`
    : isMinor
      ? `${Math.abs(val)}`
      : `${Math.abs(val).toFixed(2)}`;

  const srText = isPositive
    ? `Gain of ${magnitudeText}`
    : isNegative
      ? `Loss of ${magnitudeText}`
      : 'No change';

  // 4. Accessible semantic colors (WCAG AA compliant)
  const colorClass = isPositive
    ? 'text-financial-gain'
    : isNegative
      ? 'text-financial-loss'
      : 'text-financial-neutral';

  return (
    <span
      data-testid="trend-indicator"
      data-trend={isPositive ? 'gain' : isNegative ? 'loss' : 'neutral'}
      className={`inline-flex items-center gap-1 font-mono tabular-nums ${colorClass} ${className}`}
    >
      {isPositive && (
        <ArrowUpRight
          className="w-3.5 h-3.5 text-financial-gain shrink-0"
          aria-hidden="true"
        />
      )}
      {isNegative && (
        <ArrowDownRight
          className="w-3.5 h-3.5 text-financial-loss shrink-0"
          aria-hidden="true"
        />
      )}
      {isZero && (
        <Minus
          className="w-3.5 h-3.5 text-financial-neutral shrink-0"
          aria-hidden="true"
        />
      )}
      <span className="sr-only">{srText}</span>
      <span aria-hidden="true">{displayString}</span>
    </span>
  );
}

export default TrendIndicator;
