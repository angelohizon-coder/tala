/**
 * monte-carlo.test.ts
 * Unit & Integration verification for Milestone M5: Advanced FIRE Monte Carlo Simulation.
 * 
 * Verifies:
 * - Student's t-distribution sampling (mean, variance)
 * - Fat-tail risk modeling (kurtosis > 3, Student's t excess kurtosis)
 * - Minimum 5,000 discrete iterations execution using Float64Array
 * - Statistical convergence (verified standard error SE <= 0.01 at N = 5000)
 * - Probability Density Function (PDF) of depletion years
 * - Trajectory fan chart percentiles (P10 <= P50 <= P90)
 * - Zero-volatility deterministic compounding benchmark
 * - Web Worker simulation message interface
 */

import { describe, it, expect } from 'vitest';
import {
  sampleGaussian,
  sampleStudentT,
  calculateKurtosis,
  runFireSimulation,
  type FireSimulationParams
} from '../src/workers/fireSimulation';

describe('Advanced FIRE Monte Carlo Simulation (R5)', () => {
  describe('Student’s t-Distribution Sampling', () => {
    it('generates standard Gaussian samples centered at zero with unit variance', () => {
      const N = 20000;
      let sum = 0;
      let sumSq = 0;

      for (let i = 0; i < N; i++) {
        const val = sampleGaussian();
        sum += val;
        sumSq += val * val;
      }

      const mean = sum / N;
      const variance = (sumSq / N) - (mean * mean);

      expect(Math.abs(mean)).toBeLessThan(0.05);
      expect(variance).toBeGreaterThan(0.92);
      expect(variance).toBeLessThan(1.08);
    });

    it('generates Student’s t-distribution (nu=5) with theoretical variance ~ 1.67', () => {
      const N = 30000;
      const df = 5;
      let sum = 0;
      let sumSq = 0;

      for (let i = 0; i < N; i++) {
        const val = sampleStudentT(df);
        sum += val;
        sumSq += val * val;
      }

      const mean = sum / N;
      const variance = (sumSq / N) - (mean * mean);

      // Theoretical variance for df=5 is 5 / (5 - 2) = 1.6667
      expect(Math.abs(mean)).toBeLessThan(0.08);
      expect(variance).toBeGreaterThan(1.4);
      expect(variance).toBeLessThan(2.0);
    });

    it('scaled Student’s t-distribution achieves unit variance via sqrt((df - 2) / df)', () => {
      const N = 30000;
      const df = 5;
      const scale = Math.sqrt((df - 2) / df); // sqrt(3/5) ~ 0.7746
      let sum = 0;
      let sumSq = 0;

      for (let i = 0; i < N; i++) {
        const val = sampleStudentT(df) * scale;
        sum += val;
        sumSq += val * val;
      }

      const mean = sum / N;
      const variance = (sumSq / N) - (mean * mean);

      expect(Math.abs(mean)).toBeLessThan(0.06);
      expect(variance).toBeGreaterThan(0.90);
      expect(variance).toBeLessThan(1.10);
    });
  });

  describe('Fat-Tailed Risk & Kurtosis', () => {
    it('verifies standard Gaussian kurtosis is approximately 3.0', () => {
      const N = 30000;
      const samples = new Float64Array(N);

      for (let i = 0; i < N; i++) {
        samples[i] = sampleGaussian();
      }

      const kurt = calculateKurtosis(samples);
      // Gaussian distribution kurtosis is ~3.0
      expect(kurt).toBeGreaterThan(2.7);
      expect(kurt).toBeLessThan(3.3);
    });

    it('verifies Student’s t-distribution (nu=5) exhibits fat tails with kurtosis > 3.0', () => {
      const N = 50000;
      const samples = new Float64Array(N);

      for (let i = 0; i < N; i++) {
        samples[i] = sampleStudentT(5);
      }

      const kurt = calculateKurtosis(samples);
      // Theoretical kurtosis for df=5 is 3 + 6 / (5 - 4) = 9.0
      // Due to heavy tails in finite samples, sample kurtosis is strictly > 3.0 (typically 5 to 14)
      expect(kurt).toBeGreaterThan(3.5);
    });

    it('exhibits heavier tail risk with nu=3 compared to nu=5', () => {
      const N = 40000;
      const samplesT3 = new Float64Array(N);
      const samplesT5 = new Float64Array(N);

      for (let i = 0; i < N; i++) {
        samplesT3[i] = sampleStudentT(3);
        samplesT5[i] = sampleStudentT(5);
      }

      const kurt3 = calculateKurtosis(samplesT3);
      const kurt5 = calculateKurtosis(samplesT5);

      expect(kurt3).toBeGreaterThan(kurt5);
      expect(kurt3).toBeGreaterThan(4.0);
    });
  });

  describe('Simulation Scale & Performance', () => {
    it('enforces minimum 5,000 discrete iterations execution', () => {
      const params: FireSimulationParams = {
        initialAssets: 1000000000,
        annualContribution: 50000000,
        annualExpenses: 40000000,
        iterations: 1000, // Attempt under 5,000
        years: 30
      };

      const result = runFireSimulation(params);
      expect(result.iterations).toBeGreaterThanOrEqual(5000);
      expect(result.percentiles.p50.length).toBe(31);
    });

    it('executes 5,000 iterations using Float64Array buffers with high performance (< 250ms)', () => {
      const params: FireSimulationParams = {
        initialAssets: 500000000,
        annualContribution: 30000000,
        annualExpenses: 25000000,
        expectedReturn: 0.07,
        returnVolatility: 0.16,
        degreesOfFreedom: 5,
        expectedInflation: 0.03,
        inflationVolatility: 0.01,
        iterations: 5000,
        years: 40
      };

      const t0 = performance.now();
      const result = runFireSimulation(params);
      const duration = performance.now() - t0;

      expect(result.iterations).toBe(5000);
      expect(result.trajectories.length).toBe(41);
      expect(duration).toBeLessThan(250); // High throughput execution
    });
  });

  describe('Statistical Convergence (SE <= 0.01 at N = 5000)', () => {
    it('guarantees standard error SE <= 0.01 across arbitrary success rates', () => {
      const testCases: FireSimulationParams[] = [
        // Low survival rate scenario
        { initialAssets: 20000000, annualContribution: 0, annualExpenses: 80000000, iterations: 5000, years: 20 },
        // High survival rate scenario
        { initialAssets: 10000000000, annualContribution: 100000000, annualExpenses: 10000000, iterations: 5000, years: 30 },
        // Mid-range survival rate scenario
        { initialAssets: 500000000, annualContribution: 0, annualExpenses: 30000000, iterations: 5000, years: 35 }
      ];

      for (const params of testCases) {
        const result = runFireSimulation(params);
        expect(result.standardError).toBeLessThanOrEqual(0.01);
        expect(result.convergence.standardError).toBeLessThanOrEqual(0.01);

        const [ciLower, ciUpper] = result.convergence.confidenceInterval95;
        expect(ciLower).toBeGreaterThanOrEqual(0);
        expect(ciUpper).toBeLessThanOrEqual(1);
        expect(ciUpper - ciLower).toBeLessThanOrEqual(0.04); // 95% CI width <= 4%
      }
    });
  });

  describe('Probability Density Function (PDF) of Depletion Years', () => {
    it('outputs valid PDF where probabilities are bounded and sum <= 1.0', () => {
      const params: FireSimulationParams = {
        initialAssets: 300000000,
        annualContribution: 0,
        annualExpenses: 25000000,
        iterations: 5000,
        years: 30,
        degreesOfFreedom: 5
      };

      const result = runFireSimulation(params);
      const pdf = result.depletionYearPdf;
      expect(pdf).toBeDefined();

      let sumPdf = 0;
      for (let yr = 0; yr <= 30; yr++) {
        const p = pdf[yr];
        expect(typeof p).toBe('number');
        expect(p).toBeGreaterThanOrEqual(0.0);
        expect(p).toBeLessThanOrEqual(1.0);
        sumPdf += p;
      }

      // Total depletion probability + success rate = 1.0
      expect(sumPdf).toBeLessThanOrEqual(1.0001);
      expect(Math.abs((sumPdf + result.successRate) - 1.0)).toBeLessThan(0.0001);
    });

    it('concentrates depletion PDF in early years during rapid depletion', () => {
      const params: FireSimulationParams = {
        initialAssets: 10000000,
        annualContribution: 0,
        annualExpenses: 100000000, // 10x initial assets in year 1
        iterations: 5000,
        years: 30,
        degreesOfFreedom: 5
      };

      const result = runFireSimulation(params);
      expect(result.successRate).toBe(0.0);

      const earlyProb = (result.depletionYearPdf[0] || 0) + (result.depletionYearPdf[1] || 0);
      expect(earlyProb).toBeGreaterThan(0.95);
    });

    it('yields zero depletion probability across all years for perpetual endowment', () => {
      const params: FireSimulationParams = {
        initialAssets: 100000000000, // 1 billion
        annualContribution: 0,
        annualExpenses: 1000000,     // 10k/yr
        expectedReturn: 0.08,
        returnVolatility: 0.05,
        iterations: 5000,
        years: 30
      };

      const result = runFireSimulation(params);
      expect(result.successRate).toBeGreaterThanOrEqual(0.999);

      for (const prob of Object.values(result.depletionYearPdf)) {
        expect(prob).toBe(0.0);
      }
    });
  });

  describe('Percentile Trajectory Fan Charts (P10, P50, P90)', () => {
    it('maintains ordering invariant P10 <= P50 <= P90 at every horizon year', () => {
      const params: FireSimulationParams = {
        initialAssets: 1000000000,
        annualContribution: 40000000,
        annualExpenses: 35000000,
        iterations: 5000,
        years: 35,
        degreesOfFreedom: 5
      };

      const result = runFireSimulation(params);
      const { p10, p50, p90 } = result.percentiles;

      expect(p10.length).toBe(36);
      expect(p50.length).toBe(36);
      expect(p90.length).toBe(36);

      // Initial wealth matches starting assets
      expect(p10[0]).toBe(1000000000);
      expect(p50[0]).toBe(1000000000);
      expect(p90[0]).toBe(1000000000);

      for (let yr = 0; yr <= 35; yr++) {
        expect(p10[yr]).toBeLessThanOrEqual(p50[yr]);
        expect(p50[yr]).toBeLessThanOrEqual(p90[yr]);
      }
    });

    it('conforms to deterministic compounding benchmark when volatility is zero', () => {
      const initial = 10000000;
      const rate = 0.10;
      const Y = 5;

      const params: FireSimulationParams = {
        initialAssets: initial,
        annualContribution: 0,
        annualExpenses: 0,
        expectedReturn: rate,
        returnVolatility: 0.0,
        expectedInflation: 0.0,
        inflationVolatility: 0.0,
        iterations: 5000,
        years: Y
      };

      const result = runFireSimulation(params);
      expect(result.successRate).toBe(1.0);

      for (let yr = 0; yr <= Y; yr++) {
        const expected = Math.round(initial * Math.pow(1 + rate, yr));
        expect(Math.round(result.percentiles.p50[yr])).toBe(expected);
        expect(Math.round(result.percentiles.p10[yr])).toBe(expected);
        expect(Math.round(result.percentiles.p90[yr])).toBe(expected);
      }
    });
  });

  describe('Long Horizon Boundary & Heavy Tails', () => {
    it('executes 80-year horizon without memory exhaustion or NaN values', () => {
      const params: FireSimulationParams = {
        initialAssets: 500000000,
        annualContribution: 10000000,
        annualExpenses: 15000000,
        iterations: 5000,
        years: 80,
        degreesOfFreedom: 5
      };

      const result = runFireSimulation(params);
      expect(result.percentiles.p50.length).toBe(81);
      expect(Number.isFinite(result.medianEndingAssets)).toBe(true);
      expect(Number.isFinite(result.successRate)).toBe(true);
    });

    it('handles extreme fat tails (nu = 3) gracefully', () => {
      const params: FireSimulationParams = {
        initialAssets: 400000000,
        annualContribution: 0,
        annualExpenses: 20000000,
        iterations: 5000,
        years: 30,
        degreesOfFreedom: 3
      };

      const result = runFireSimulation(params);
      expect(result.degreesOfFreedom).toBe(3);
      expect(result.standardError).toBeLessThanOrEqual(0.01);
      expect(result.percentiles.p10.length).toBe(31);
    });
  });
});
