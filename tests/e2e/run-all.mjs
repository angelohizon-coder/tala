/**
 * run-all.mjs
 * Unified test runner for Tala Modernization E2E & Acceptance Test Suites.
 * 
 * Runs Tier 1 (Features), Tier 2 (Boundaries), Tier 3 (Interactions),
 * Tier 4 (Scenarios), and Acceptance Criteria suites.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..', '..');

const testSuites = [
  // Acceptance Criteria
  'tests/acceptance/acceptance-criteria.test.mjs',
  // Tier 1: Feature Coverage
  'tests/e2e/tier1-features/r1-security-sync.test.mjs',
  'tests/e2e/tier1-features/r2-financial-integrity.test.mjs',
  'tests/e2e/tier1-features/r3-market-gateway.test.mjs',
  'tests/e2e/tier1-features/r4-ml-categorization.test.mjs',
  'tests/e2e/tier1-features/r5-monte-carlo-fire.test.mjs',
  'tests/e2e/tier1-features/r6-ui-a11y.test.mjs',
  // Tier 2: Boundary & Corner Cases
  'tests/e2e/tier2-boundaries/boundary-financial.test.mjs',
  'tests/e2e/tier2-boundaries/boundary-sync-concurrency.test.mjs',
  'tests/e2e/tier2-boundaries/boundary-gateway-resilience.test.mjs',
  'tests/e2e/tier2-boundaries/boundary-ml-edgecases.test.mjs',
  'tests/e2e/tier2-boundaries/boundary-fire-convergence.test.mjs',
  // Tier 3: Cross-Feature Interactions
  'tests/e2e/tier3-interactions/pairwise-sync-security.test.mjs',
  'tests/e2e/tier3-interactions/pairwise-valuation-market.test.mjs',
  'tests/e2e/tier3-interactions/pairwise-ml-sync.test.mjs',
  'tests/e2e/tier3-interactions/pairwise-fire-multicurrency.test.mjs',
  // Tier 4: Real-World Application Scenarios
  'tests/e2e/tier4-scenarios/scenario-onboarding-local.test.mjs',
  'tests/e2e/tier4-scenarios/scenario-cross-currency-transfer.test.mjs',
  'tests/e2e/tier4-scenarios/scenario-offline-reconnect-sync.test.mjs',
  'tests/e2e/tier4-scenarios/scenario-market-outage-stale.test.mjs',
  'tests/e2e/tier4-scenarios/scenario-csv-ml-import.test.mjs',
  'tests/e2e/tier4-scenarios/scenario-fire-stochastic-plan.test.mjs',
  'tests/e2e/tier4-scenarios/scenario-accessibility-audit.test.mjs'
];

console.log('='.repeat(70));
console.log('  TALA FINANCIAL SPA MODERNIZATION — E2E & ACCEPTANCE TEST RUNNER');
console.log('='.repeat(70));
console.log(`Running ${testSuites.length} test suites with Node test runner...\n`);

const args = ['--test', ...testSuites];
const child = spawn(process.execPath, args, {
  cwd: projectRoot,
  stdio: 'inherit'
});

child.on('exit', (code) => {
  console.log('\n' + '='.repeat(70));
  if (code === 0) {
    console.log('  ALL E2E & ACCEPTANCE TEST SUITES PASSED (100% SUCCESS)');
  } else {
    console.log(`  TEST SUITE COMPLETED WITH CODE ${code}`);
  }
  console.log('='.repeat(70));
  process.exit(code);
});
