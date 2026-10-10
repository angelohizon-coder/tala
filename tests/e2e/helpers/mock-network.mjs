/**
 * mock-network.mjs
 * Simulates network interception and validates zero-outbound call invariants.
 */

export class MockNetworkGate {
  constructor(privacyMode = 'LOCAL_ONLY') {
    this.privacyMode = privacyMode; // 'LOCAL_ONLY' | 'CLOUD_SYNC'
    this.isOnline = true;
    this.recordedRequests = [];
  }

  setPrivacyMode(mode) {
    this.privacyMode = mode;
  }

  setOnline(online) {
    this.isOnline = Boolean(online);
  }

  /**
   * Dispatches a network request attempt.
   * Throws if in LOCAL_ONLY mode and an outbound call is made to prohibited endpoints.
   */
  async fetch(url, options = {}) {
    const entry = {
      url: String(url),
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      timestamp: Date.now(),
      privacyMode: this.privacyMode,
      online: this.isOnline
    };
    this.recordedRequests.push(entry);

    if (this.privacyMode === 'LOCAL_ONLY') {
      const isRemoteCall =
        url.includes('firebase') ||
        url.includes('firestore') ||
        url.includes('googleapis') ||
        url.includes('openbanking');
      if (isRemoteCall) {
        throw new Error(`Privacy violation: Outbound network request to ${url} in LOCAL_ONLY mode`);
      }
    }

    if (!this.isOnline) {
      throw new Error(`Network offline: Unable to reach ${url}`);
    }

    return {
      status: 200,
      ok: true,
      json: async () => ({}),
      text: async () => ''
    };
  }

  getOutboundCount(filterPattern = null) {
    if (!filterPattern) return this.recordedRequests.length;
    return this.recordedRequests.filter(r => r.url.includes(filterPattern)).length;
  }

  clear() {
    this.recordedRequests = [];
  }
}
