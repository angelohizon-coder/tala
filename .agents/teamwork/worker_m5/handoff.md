# Handoff Report — Milestone M5: Advanced FIRE Monte Carlo Simulation

**Agent**: Worker 5 (`teamwork_preview_worker`)  
**Milestone**: M5 (Advanced FIRE Monte Carlo Simulation)  
**Parent Conversation ID**: `64bc598d-7c84-4fe3-b439-553f079769f4`  
**Date**: 2026-10-09  

---

## 1. Observation

1. **Deterministic Loop in PlanningPages.tsx**:
   Prior to this milestone, `src/pages/PlanningPages.tsx` (lines 14-16) calculated future retirement wealth via a simple 40-year deterministic loop:
   ```typescript
   assets = assets * (1 + settings.investmentReturnAssumption) + settings.monthlyContribution * 12;
   target *= 1 + settings.inflationAssumption;
   ```
   This calculation omitted sequence-of-returns risk, volatility drag ($R_{\text{geo}} \approx \mu - \frac{\sigma^2}{2}$), and fat-tailed market crash distributions.

2. **Milestone Exclusive File Scope**:
   Exclusive file ownership was designated as:
   - `src/workers/monteCarlo.worker.ts`
   - `src/workers/fireSimulation.ts`
   - `src/pages/PlanningPages.tsx`
   - `tests/monte-carlo.test.ts`

3. **Mathematical Invariants**:
   - Parameterized fat-tailed Student's t-distribution ($\nu = 5$) with Box-Muller normal sampling and Chi-Square scaling.
   - Theoretical kurtosis for Student's t with $\nu=5$ is $3 + \frac{6}{\nu - 4} = 9.0 > 3.0$.
   - Scale factor for Student's t return: $\sigma \sqrt{\frac{\nu - 2}{\nu}} \cdot T$ to preserve user volatility $\sigma$.
   - Discrete iteration minimum: $N \ge 5000$.
   - Float64Array buffer throughput: `new Float64Array(N * (Y + 1))` allocated for high cache locality and fast numerical sort.
   - Standard Error bound: For $N = 5000$, $\max \operatorname{SE}(p) = \sqrt{\frac{0.5 \times 0.5}{5000}} \approx 0.00707 \le 0.01$.

4. **Verification Command Outputs**:
   - TypeScript compilation (`node ./node_modules/typescript/bin/tsc --noEmit`):
     ```
     Exit code: 0 (0 errors)
     ```
   - Vitest suite (`node ./node_modules/vitest/vitest.mjs run tests/monte-carlo.test.ts`):
     ```
     ✓ tests/monte-carlo.test.ts (16 tests) 550ms
     Test Files  1 passed (1)
     Tests  16 passed (16)
     Duration  687ms
     ```
   - E2E test suite runner (`node tests/e2e/run-all.mjs`):
     ```
     ℹ tests 93
     ℹ suites 23
     ℹ pass 93
     ℹ fail 0
     ALL E2E & ACCEPTANCE TEST SUITES PASSED (100% SUCCESS)
     ```
   - Vite production build (`node ./node_modules/vite/bin/vite.js build`):
     ```
     dist/assets/monteCarlo.worker-orA4zcvU.js    2.07 kB
     dist/assets/PlanningPages-PxZ2iJJf.js       77.05 kB
     ✓ built in 903ms
     Exit code: 0
     ```

---

## 2. Logic Chain

1. **Stochastic Engine Implementation (`src/workers/fireSimulation.ts`)**:
   - Ref: Observation 3.
   - Implemented Box-Muller Gaussian sampling (`sampleGaussian()`), exact Student's t generator (`sampleStudentT(df)`), and kurtosis computation (`calculateKurtosis()`).
   - Implemented `runFireSimulation(params)` utilizing a contiguous `Float64Array(N * (Y + 1))` buffer and `Int16Array(N)` depletion year array.
   - For each year step, computed inflation-adjusted spending and fat-tail return $r = \mu + \sigma \sqrt{\frac{\nu-2}{\nu}} T$, capturing volatility drag and sequence-of-returns risk.
   - Sorted annual slices using in-place `yearAssets.sort()` to extract exact P10, P25, P50, P75, and P90 quantile paths.
   - Generated the Depletion Year Probability Density Function (PDF) across all horizon years $0 \le yr \le Y$.
   - Provided client wrapper `runFireSimulationInWorker(params)` that delegates execution to `new Worker(...)` with a synchronous local fallback for non-worker environments.

2. **Dedicated Web Worker (`src/workers/monteCarlo.worker.ts`)**:
   - Ref: Observation 2, 3.
   - Created Dedicated Web Worker listening to `START_SIMULATION` inbound messages, executing `runFireSimulation`, and posting `SIMULATION_RESULT` back to the UI thread with the matching request ID.

3. **UI Integration (`src/pages/PlanningPages.tsx`)**:
   - Ref: Observation 1.
   - Replaced deterministic loop with asynchronous worker simulation triggered via `useEffect` whenever FIRE assets, target, or planning assumptions change.
   - Added `isSimulating` indicator so the UI stays responsive without freezing during simulation runs.
   - Rendered percentile fan charts (P10 conservative, P50 median, P90 optimistic, and inflation-adjusted target line) in Recharts `<AreaChart>`.
   - Rendered Depletion Year PDF distribution in Recharts `<BarChart>` with probability tooltips.
   - Displayed plan success probability, convergence standard error ($\pm \text{SE}\%$), and Student's t parameter badges.
   - Preserved honest empty states when financial prerequisites are incomplete.

4. **Testing & Verification (`tests/monte-carlo.test.ts`)**:
   - Ref: Observation 4.
   - Authored 16 unit and integration tests covering:
     1. Student's t Gaussian generator unit variance and Student's t theoretical variance.
     2. Kurtosis comparison (Gaussian $\approx 3.0$ vs Student's t $\nu=5$ kurtosis $> 3.5$, and $\nu=3$ kurtosis $> 4.0$).
     3. Minimum 5,000 iterations enforcement and sub-250ms Float64Array execution speed.
     4. Verified convergence bound ($\operatorname{SE} \le 0.01$ across low, mid, and high survival regimes).
     5. Depletion Year PDF structure, boundary constraints, and conservation of probability ($\sum \text{PDF} + \text{SuccessRate} = 1.0$).
     6. Percentile ordering invariant ($P10 \le P50 \le P90$ at all time steps).
     7. Deterministic compounding equivalence when return and inflation volatilities are zero.
     8. 80-year horizon memory safety and extreme fat-tail robustness.

---

## 3. Caveats

- **Web Worker Support in Headless Node / Vitest**: In Node environments without native `Worker` globals, `runFireSimulationInWorker` gracefully falls back to local execution. In browser environments (Vite preview and production), the Dedicated Web Worker executes asynchronously in a background thread.
- **Degrees of Freedom Parameter Range**: Degrees of freedom $\nu$ is constrained to $\nu \ge 1$ by clamping; for $\nu \le 2$, variance scaling defaults to $1.0$ because the variance of Student's t is undefined for $\nu \le 2$. For financial simulations, the default $\nu = 5$ operates within the finite-variance, fat-tailed regime.

---

## 4. Conclusion

Milestone M5 is completely implemented, verified, and integrated into Tala.
- Deterministic FIRE calculator in `PlanningPages.tsx` is fully upgraded to stochastic Monte Carlo simulations using Student's t-distribution ($\nu = 5$).
- Web Worker architecture (`src/workers/monteCarlo.worker.ts`) executes 5,000+ iterations via `Float64Array` typed buffers without freezing the UI thread.
- UI renders P10, P50, and P90 percentile trajectory fan charts and a Depletion Year Probability Density Function (PDF) bar chart.
- Statistical convergence satisfies $\operatorname{SE} \le 0.01$ at $N = 5000$.
- All verification gates pass: `tsc --noEmit` (0 errors), Vitest `tests/monte-carlo.test.ts` (16/16 passed), full E2E suites `run-all.mjs` (93/93 passed), and Vite production build (0 errors).

---

## 5. Verification Method

To independently reproduce and verify this work:

1. **Typecheck**:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;" + $env:PATH
   & "C:\Program Files\nodejs\node.exe" ./node_modules/typescript/bin/tsc --noEmit
   ```
   *Expected outcome*: Exits with code 0.

2. **Run Monte Carlo Vitest Suite**:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;" + $env:PATH
   & "C:\Program Files\nodejs\node.exe" ./node_modules/vitest/vitest.mjs run tests/monte-carlo.test.ts
   ```
   *Expected outcome*: 16 tests pass with 0 failures in under 1 second.

3. **Run Unified E2E Test Suite**:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;" + $env:PATH
   & "C:\Program Files\nodejs\node.exe" tests/e2e/run-all.mjs
   ```
   *Expected outcome*: All 93 tests across 23 suites pass (100% success).

4. **Production Vite Build**:
   ```powershell
   $env:PATH = "C:\Program Files\nodejs;" + $env:PATH
   & "C:\Program Files\nodejs\node.exe" ./node_modules/vite/bin/vite.js build
   ```
   *Expected outcome*: Bundles `dist/assets/monteCarlo.worker-*.js` and `dist/assets/PlanningPages-*.js` with exit code 0.

5. **Code Inspection**:
   - `src/workers/fireSimulation.ts`
   - `src/workers/monteCarlo.worker.ts`
   - `src/pages/PlanningPages.tsx`
   - `tests/monte-carlo.test.ts`
