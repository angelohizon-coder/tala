/**
 * monteCarlo.worker.ts
 * Dedicated Web Worker for Advanced FIRE Monte Carlo Simulation.
 * 
 * Executes 5,000+ stochastic iterations utilizing parameterized Student's t-distribution (nu=5)
 * and Float64Array typed buffers without blocking the main UI thread.
 * Complies with Tala Modernization Requirement R5 and PROJECT.md contract.
 */

/// <reference lib="webworker" />
import { runFireSimulation, type FireSimulationParams } from './fireSimulation';

self.onmessage = (e: MessageEvent) => {
  const data = e.data;
  if (!data) return;

  if (data.type === 'START_SIMULATION') {
    const payload = (data.payload || {}) as FireSimulationParams;
    const result = runFireSimulation(payload);

    self.postMessage({
      type: 'SIMULATION_RESULT',
      payload: result,
      requestId: data.requestId
    });
  }
};
