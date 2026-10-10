/**
 * mock-weblocks.mjs
 * Simulates navigator.locks for multi-tab concurrency and serialization testing.
 */

export class MockWebLockManager {
  constructor() {
    this.locks = new Map(); // name -> Promise chain
    this.activeHolders = new Map(); // name -> holder count
    this.executionLog = [];
  }

  /**
   * Request an exclusive lock by name, executing the callback when acquired.
   * @param {string} name - Lock name e.g. 'tala_sync'
   * @param {() => Promise<any>} callback - Lock worker
   * @param {string} [tabId] - Identifying tab
   */
  async request(name, callback, tabId = 'default_tab') {
    const prevPromise = this.locks.get(name) || Promise.resolve();

    let release;
    const currentPromise = new Promise((res) => {
      release = res;
    });

    // Chain this request behind previous holders
    this.locks.set(name, prevPromise.then(() => currentPromise));

    await prevPromise;

    // Critical section start
    const holders = (this.activeHolders.get(name) || 0) + 1;
    this.activeHolders.set(name, holders);
    this.executionLog.push({ tabId, event: 'acquire', timestamp: Date.now(), holders });

    if (holders > 1) {
      throw new Error(`Lock concurrency violation: ${holders} active holders for lock ${name}`);
    }

    try {
      const result = await callback();
      return result;
    } finally {
      const remainingHolders = (this.activeHolders.get(name) || 1) - 1;
      this.activeHolders.set(name, remainingHolders);
      this.executionLog.push({ tabId, event: 'release', timestamp: Date.now(), holders: remainingHolders });
      release();
    }
  }

  getLog() {
    return [...this.executionLog];
  }

  clear() {
    this.locks.clear();
    this.activeHolders.clear();
    this.executionLog = [];
  }
}
