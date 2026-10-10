/**
 * fireSimulation.ts
 * High-performance Monte Carlo FIRE simulation engine with Student's t-distribution fat tails.
 * 
 * Complies with Tala Modernization Requirement R5 and PROJECT.md contract.
 * - Parameterized fat-tailed Student's t-distribution (nu = 5)
 * - Minimum 5,000 discrete iterations
 * - Float64Array typed buffers for performance & cache locality
 * - Probability Density Function (PDF) of depletion years
 * - Trajectory percentiles (P10, P25, P50, P75, P90)
 * - Verified statistical convergence (SE <= 0.01 at N = 5000)
 */

export interface FireSimulationParams {
  initialAssets?: number;
  annualContribution?: number;
  annualExpenses?: number;
  annualSpending?: number;
  expectedReturn?: number;
  equityMean?: number;
  returnVolatility?: number;
  equityStd?: number;
  degreesOfFreedom?: number;
  equityDegreesOfFreedom?: number;
  expectedInflation?: number;
  inflationMean?: number;
  inflationVolatility?: number;
  inflationStd?: number;
  iterations?: number;
  years?: number;
  horizonYears?: number;
}

export interface TrajectoryPoint {
  year: number;
  p10: number;
  p25?: number;
  p50: number;
  p75?: number;
  p90: number;
}

export interface FireSimulationResult {
  iterations: number;
  successRate: number;
  trajectories: TrajectoryPoint[];
  percentiles: {
    p10: number[];
    p25?: number[];
    p50: number[];
    p75?: number[];
    p90: number[];
  };
  depletionYearPdf: Record<number, number>;
  standardError: number;
  degreesOfFreedom: number;
  medianEndingAssets: number;
  convergence: {
    standardError: number;
    confidenceInterval95: [number, number];
    executionTimeMs: number;
  };
}

/**
 * Box-Muller transform generates standard Gaussian random variable Z ~ N(0, 1).
 */
export function sampleGaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Samples Student's t-distribution with df degrees of freedom.
 * Uses ratio of standard normal Z and independent chi-square variable V / df:
 * T = Z / sqrt(V / df), where V = sum_{k=1}^df Z_k^2.
 */
export function sampleStudentT(df: number): number {
  const safeDf = Math.max(1, Math.round(df));
  const z = sampleGaussian();
  let v = 0;
  for (let i = 0; i < safeDf; i++) {
    const g = sampleGaussian();
    v += g * g;
  }
  return z / Math.sqrt(v / safeDf);
}

/**
 * Calculates excess sample kurtosis and raw kurtosis of a numeric dataset.
 * For Gaussian distributions, kurtosis = 3.
 * For Student's t with df = 5, theoretical kurtosis = 3 + 6/(5 - 4) = 9 (fat-tailed).
 */
export function calculateKurtosis(samples: ArrayLike<number>): number {
  const n = samples.length;
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += samples[i];
  }
  const mean = sum / n;
  let sumSq = 0;
  let sumFourth = 0;
  for (let i = 0; i < n; i++) {
    const diff = samples[i] - mean;
    const diffSq = diff * diff;
    sumSq += diffSq;
    sumFourth += diffSq * diffSq;
  }
  const variance = sumSq / n;
  if (variance === 0) return 0;
  return (sumFourth / n) / (variance * variance);
}

/**
 * Runs stochastic FIRE Monte Carlo simulation using Float64Array buffers.
 * Enforces minimum N = 5000 iterations to guarantee statistical convergence (SE <= 0.01).
 */
export function runFireSimulation(params: FireSimulationParams): FireSimulationResult {
  const startTime = typeof performance !== 'undefined' ? performance.now() : Date.now();

  const N = Math.max(5000, params.iterations ?? 5000);
  const Y = params.horizonYears ?? params.years ?? 40;
  const df = params.degreesOfFreedom ?? params.equityDegreesOfFreedom ?? 5;
  const initialAssets = params.initialAssets ?? 0;
  const annualContrib = params.annualContribution ?? 0;
  const annualExpenses = params.annualExpenses ?? params.annualSpending ?? 0;
  const expectedReturn = params.equityMean ?? params.expectedReturn ?? 0.07;
  const returnVol = params.equityStd ?? params.returnVolatility ?? 0.16;
  const expectedInflation = params.inflationMean ?? params.expectedInflation ?? 0.03;
  const inflationVol = params.inflationStd ?? params.inflationVolatility ?? 0.01;

  // Student's t variance correction scale factor: sqrt((df - 2) / df) for df > 2
  const tScale = df > 2 ? Math.sqrt((df - 2) / df) : 1.0;

  // Float64Array typed buffer: N iterations x (Y + 1) years
  const assetPaths = new Float64Array(N * (Y + 1));
  const depletionYears = new Int16Array(N);
  depletionYears.fill(-1);

  let successfulRuns = 0;

  for (let iter = 0; iter < N; iter++) {
    let currentAssets = initialAssets;
    assetPaths[iter * (Y + 1) + 0] = currentAssets;
    let depletedAt = -1;

    for (let yr = 1; yr <= Y; yr++) {
      if (currentAssets <= 0 && annualContrib <= 0) {
        if (depletedAt === -1) depletedAt = yr - 1;
        assetPaths[iter * (Y + 1) + yr] = 0;
        continue;
      }

      // Sample Student's t return (or deterministic if volatility is 0)
      const t = sampleStudentT(df);
      const r = returnVol === 0 ? expectedReturn : Math.max(-1.0, expectedReturn + returnVol * tScale * t);

      // Sample inflation
      const inf = inflationVol === 0 ? expectedInflation : expectedInflation + inflationVol * sampleGaussian();

      // Inflation-adjusted spending
      const adjustedExpenses = annualExpenses * Math.pow(1 + inf, yr);

      // Wealth transition
      currentAssets = currentAssets * (1 + r) + annualContrib - adjustedExpenses;
      if (currentAssets < 0) currentAssets = 0;

      assetPaths[iter * (Y + 1) + yr] = currentAssets;
    }

    if (currentAssets > 0) {
      successfulRuns++;
    } else if (depletedAt === -1) {
      depletedAt = Y;
    }
    depletionYears[iter] = depletedAt;
  }

  // Trajectory quantiles per year
  const trajectories: TrajectoryPoint[] = [];
  const p10: number[] = [];
  const p25: number[] = [];
  const p50: number[] = [];
  const p75: number[] = [];
  const p90: number[] = [];
  const yearAssets = new Float64Array(N);

  for (let yr = 0; yr <= Y; yr++) {
    for (let iter = 0; iter < N; iter++) {
      yearAssets[iter] = assetPaths[iter * (Y + 1) + yr];
    }
    yearAssets.sort(); // TypedArray in-place numerical ascending sort

    const q10 = yearAssets[Math.floor(N * 0.10)];
    const q25 = yearAssets[Math.floor(N * 0.25)];
    const q50 = yearAssets[Math.floor(N * 0.50)];
    const q75 = yearAssets[Math.floor(N * 0.75)];
    const q90 = yearAssets[Math.floor(N * 0.90)];

    p10.push(q10);
    p25.push(q25);
    p50.push(q50);
    p75.push(q75);
    p90.push(q90);

    trajectories.push({
      year: yr,
      p10: q10,
      p25: q25,
      p50: q50,
      p75: q75,
      p90: q90
    });
  }

  // Depletion Year Probability Density Function (PDF)
  const depletionCounts = new Int32Array(Y + 1);
  for (let iter = 0; iter < N; iter++) {
    const dep = depletionYears[iter];
    if (dep >= 0 && dep <= Y) {
      depletionCounts[dep]++;
    }
  }

  const depletionYearPdf: Record<number, number> = {};
  for (let yr = 0; yr <= Y; yr++) {
    depletionYearPdf[yr] = depletionCounts[yr] / N;
  }

  const successRate = successfulRuns / N;
  // Standard Error of success rate: sqrt(p * (1 - p) / N) <= 0.01 for N >= 5000
  const standardError = Math.sqrt((successRate * (1 - successRate)) / N);
  const endTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const executionTimeMs = endTime - startTime;

  return {
    iterations: N,
    successRate,
    trajectories,
    percentiles: { p10, p25, p50, p75, p90 },
    depletionYearPdf,
    standardError,
    degreesOfFreedom: df,
    medianEndingAssets: p50[Y] ?? 0,
    convergence: {
      standardError,
      confidenceInterval95: [
        Math.max(0, successRate - 1.96 * standardError),
        Math.min(1, successRate + 1.96 * standardError)
      ],
      executionTimeMs
    }
  };
}

let fireWorkerInstance: Worker | null = null;
let activeRequestId = 0;

/**
 * Returns or initializes the dedicated Web Worker singleton.
 */
export function getFireSimulationWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (!fireWorkerInstance) {
    try {
      fireWorkerInstance = new Worker(
        new URL('./monteCarlo.worker.ts', import.meta.url),
        { type: 'module' }
      );
    } catch {
      fireWorkerInstance = null;
    }
  }
  return fireWorkerInstance;
}

/**
 * Terminates active worker process.
 */
export function terminateFireSimulationWorker(): void {
  if (fireWorkerInstance) {
    fireWorkerInstance.terminate();
    fireWorkerInstance = null;
  }
}

/**
 * Executes FIRE simulation asynchronously in the Dedicated Web Worker
 * to prevent UI thread blockage. Falls back gracefully to local execution
 * if Web Workers are unavailable in the runtime environment.
 */
export async function runFireSimulationInWorker(
  params: FireSimulationParams
): Promise<FireSimulationResult> {
  if (typeof Worker === 'undefined') {
    return runFireSimulation(params);
  }

  const worker = getFireSimulationWorker();
  if (!worker) {
    return runFireSimulation(params);
  }

  return new Promise<FireSimulationResult>((resolve, reject) => {
    const reqId = ++activeRequestId;

    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'SIMULATION_RESULT' && e.data?.requestId === reqId) {
        worker.removeEventListener('message', handler);
        worker.removeEventListener('error', errorHandler);
        resolve(e.data.payload);
      }
    };

    const errorHandler = (err: ErrorEvent) => {
      worker.removeEventListener('message', handler);
      worker.removeEventListener('error', errorHandler);
      try {
        resolve(runFireSimulation(params));
      } catch (fallbackErr) {
        reject(fallbackErr);
      }
    };

    worker.addEventListener('message', handler);
    worker.addEventListener('error', errorHandler);
    worker.postMessage({
      type: 'START_SIMULATION',
      payload: params,
      requestId: reqId
    });
  });
}
