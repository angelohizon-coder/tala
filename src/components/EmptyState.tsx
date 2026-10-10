import React from 'react';

export type HonestEmptyStateKey =
  | 'accounts'
  | 'transactions'
  | 'investments'
  | 'budgets'
  | 'fire'
  | 'watchlist';

export interface HonestEmptyStateConfig {
  title: string;
  description: string;
  actionLabel?: string;
  count: number;
  hasMockData: boolean;
}

/**
 * Standardized Honest Empty State Matrix per Tala Product Philosophy (R6):
 * Zero simulated balances, zero invented transactions, zero dummy figures.
 */
export const HONEST_EMPTY_STATES: Record<HonestEmptyStateKey, HonestEmptyStateConfig> = {
  accounts: {
    count: 0,
    title: 'Start with an account',
    description: 'Add your actual bank, wallet, cash or loan balance. No personal balances are prefilled.',
    actionLabel: 'Add your first account',
    hasMockData: false,
  },
  transactions: {
    count: 0,
    title: 'Your story starts with a transaction',
    description: 'Record income, an expense, or a transfer. Every balance reflects your entries.',
    actionLabel: 'Record transaction',
    hasMockData: false,
  },
  investments: {
    count: 0,
    title: 'Build a portfolio that reflects you',
    description: 'Add an instrument, then record a purchase or dividend. Manual NAV works offline.',
    actionLabel: 'Add investment',
    hasMockData: false,
  },
  budgets: {
    count: 0,
    title: 'No budgets set',
    description: 'Create a monthly or annual category target. Actual expenses populate spending.',
    actionLabel: 'Create a budget',
    hasMockData: false,
  },
  fire: {
    count: 0,
    title: 'Give your future a starting point',
    description: 'Set annual spending or record trailing expenses to model your journey.',
    actionLabel: 'Set assumptions',
    hasMockData: false,
  },
  watchlist: {
    count: 0,
    title: 'No tracked securities',
    description: 'Search for Philippine or global stocks and funds to observe current quotes.',
    actionLabel: 'Add security',
    hasMockData: false,
  },
};

export interface EmptyStateProps {
  view?: HonestEmptyStateKey;
  title?: string;
  description?: string;
  action?: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  icon?: React.ReactNode;
  className?: string;
}

/**
 * Reusable accessible EmptyState component.
 * Renders honest onboarding guidance with visible keyboard focus styling on CTAs.
 */
export function EmptyState({
  view,
  title: customTitle,
  description: customDescription,
  action,
  actionLabel: customActionLabel,
  onAction,
  icon,
  className = '',
}: EmptyStateProps) {
  const preset = view ? HONEST_EMPTY_STATES[view] : undefined;
  const title = customTitle || preset?.title || 'Nothing here yet';
  const description = customDescription || preset?.description;
  const actionLabel = customActionLabel || preset?.actionLabel;

  return (
    <div
      role="region"
      aria-label={title}
      className={`empty-state ${className}`}
    >
      <div className="empty-symbol" aria-hidden="true">
        {icon || '✳'}
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action ? (
        action
      ) : actionLabel && onAction ? (
        <button
          type="button"
          className="button primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-tala-green focus-visible:ring-offset-2"
          onClick={onAction}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export default EmptyState;
