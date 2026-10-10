/**
 * mock-worker.mjs
 * Simulates Web Workers for ML Categorization and Monte Carlo FIRE simulations.
 */

/**
 * Box-Muller Gaussian random number generator.
 */
function sampleGaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Student's t-distribution random number generator with degrees of freedom df.
 */
function sampleStudentT(df) {
  const z = sampleGaussian();
  let v = 0;
  for (let i = 0; i < df; i++) {
    const g = sampleGaussian();
    v += g * g;
  }
  return z / Math.sqrt(v / df);
}

export class MockMonteCarloWorker {
  constructor() {
    this.onmessage = null;
    this.postMessageListeners = [];
  }

  addEventListener(type, listener) {
    if (type === 'message') this.postMessageListeners.push(listener);
  }

  postMessage(data) {
    // Execute simulation synchronously or microtask
    queueMicrotask(() => {
      this.executeSimulation(data);
    });
  }

  executeSimulation(msg) {
    const p = msg.payload || msg;
    const N = Math.max(5000, p.iterations || 5000);
    const Y = p.horizonYears || p.years || 40;
    const df = p.degreesOfFreedom || p.equityDegreesOfFreedom || 5;
    const initialAssets = p.initialAssets || 0;
    const annualContrib = p.annualContribution || 0;
    const annualExpenses = p.annualExpenses || p.annualSpending || 0;
    const expectedReturn = p.equityMean ?? p.expectedReturn ?? 0.07;
    const returnVol = p.equityStd ?? p.returnVolatility ?? 0.16;
    const expectedInflation = p.inflationMean ?? p.expectedInflation ?? 0.03;
    const inflationVol = p.inflationStd ?? p.inflationVolatility ?? 0.01;

    // Student's t variance correction scale factor: sqrt((df - 2) / df)
    const tScale = Math.sqrt((df - 2) / df);

    const assetPaths = new Float64Array(N * (Y + 1));
    const depletionYears = new Int16Array(N);

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

        const t = sampleStudentT(df);
        // Portfolio return cannot drop below -100% without margin debt
        const r = Math.max(-1.0, expectedReturn + returnVol * tScale * t);
        const inf = expectedInflation + inflationVol * sampleGaussian();

        const adjustedExpenses = annualExpenses * Math.pow(1 + inf, yr);
        currentAssets = currentAssets * (1 + r) + annualContrib - adjustedExpenses;
        if (currentAssets < 0) currentAssets = 0;

        assetPaths[iter * (Y + 1) + yr] = currentAssets;
      }

      if (currentAssets > 0) successfulRuns++;
      depletionYears[iter] = depletedAt;
    }

    // Trajectory percentiles
    const trajectories = [];
    const p10 = [], p50 = [], p90 = [];
    const yearAssets = new Float64Array(N);

    for (let yr = 0; yr <= Y; yr++) {
      for (let iter = 0; iter < N; iter++) {
        yearAssets[iter] = assetPaths[iter * (Y + 1) + yr];
      }
      yearAssets.sort();

      const q10 = yearAssets[Math.floor(N * 0.10)];
      const q50 = yearAssets[Math.floor(N * 0.50)];
      const q90 = yearAssets[Math.floor(N * 0.90)];

      p10.push(q10);
      p50.push(q50);
      p90.push(q90);

      trajectories.push({
        year: yr,
        p10: q10,
        p50: q50,
        p90: q90
      });
    }

    // Depletion Year Probability Density Function (PDF)
    const depletionCounts = new Int32Array(Y + 1);
    for (let iter = 0; iter < N; iter++) {
      if (depletionYears[iter] >= 0) {
        depletionCounts[depletionYears[iter]]++;
      }
    }

    const depletionYearPdf = {};
    for (let yr = 0; yr <= Y; yr++) {
      depletionYearPdf[yr] = depletionCounts[yr] / N;
    }

    const successRate = successfulRuns / N;
    const standardError = Math.sqrt((successRate * (1 - successRate)) / N);

    const response = {
      type: 'SIMULATION_RESULT',
      payload: {
        iterations: N,
        successRate,
        trajectories,
        percentiles: { p10, p50, p90 },
        depletionYearPdf,
        standardError,
        degreesOfFreedom: df
      }
    };

    if (typeof this.onmessage === 'function') {
      this.onmessage({ data: response });
    }
    for (const listener of this.postMessageListeners) {
      listener({ data: response });
    }
  }

  terminate() {}
}

export class MockMLCategorizerWorker {
  constructor() {
    this.onmessage = null;
    this.postMessageListeners = [];
    this.networkCalls = 0;
  }

  addEventListener(type, listener) {
    if (type === 'message') this.postMessageListeners.push(listener);
  }

  postMessage(data) {
    queueMicrotask(() => {
      this.handleMessage(data);
    });
  }

  handleMessage(msg) {
    const type = msg.type;
    if (type === 'INIT_MODEL') {
      const response = {
        type: 'INIT_SUCCESS',
        payload: { model: 'categorizer-q8.onnx', quantized: 'INT8', memoryBytes: 14200000 }
      };
      this.dispatch(response);
      return;
    }

    if (type === 'CATEGORIZE_TRANSACTIONS' || type === 'CLASSIFY_BATCH') {
      const items = msg.payload?.transactions || msg.items || [];
      const results = items.map((item) => {
        const raw = (item.description || item.merchant || '').toLowerCase();
        // Normalize accents and diacritics
        const text = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        let cat = 'cat_other';
        let name = 'Other / Miscellaneous';
        let confidence = 0.75;

        if (text.includes('meralco') || text.includes('water') || text.includes('pldt') || text.includes('globe')) {
          cat = 'cat_utilities';
          name = 'Utilities & Bills';
          confidence = 0.96;
        } else if (text.includes('market') || text.includes('puregold') || text.includes('grocery') || text.includes('sm super')) {
          cat = 'cat_groceries';
          name = 'Groceries';
          confidence = 0.94;
        } else if (text.includes('jollibee') || text.includes('mcdonalds') || text.includes('starbucks') || text.includes('restaurant') || text.includes('restauran') || text.includes('cafe') || text.includes('bistro')) {
          cat = 'cat_dining';
          name = 'Food & Dining';
          confidence = 0.91;
        } else if (text.includes('payroll') || text.includes('salary') || text.includes('compensation')) {
          cat = 'cat_income';
          name = 'Salary & Income';
          confidence = 0.98;
        } else if (text.includes('grab') || text.includes('angkas') || text.includes('shell') || text.includes('petron')) {
          cat = 'cat_transport';
          name = 'Transportation';
          confidence = 0.89;
        } else if (text.includes('col financial') || text.includes('bpi trade') || text.includes('vanguard') || text.includes('dividend')) {
          cat = 'cat_investment';
          name = 'Investments';
          confidence = 0.93;
        }

        return {
          id: item.id,
          categoryId: cat,
          categoryName: name,
          confidence,
          alternatives: [
            { categoryId: 'cat_general', categoryName: 'General', confidence: 0.1 }
          ]
        };
      });

      const response = {
        type: type === 'CATEGORIZE_TRANSACTIONS' ? 'CATEGORIZE_SUCCESS' : 'CLASSIFY_SUCCESS',
        payload: { results },
        results
      };
      this.dispatch(response);
    }
  }

  dispatch(data) {
    if (typeof this.onmessage === 'function') {
      this.onmessage({ data });
    }
    for (const listener of this.postMessageListeners) {
      listener({ data });
    }
  }

  terminate() {}
}
