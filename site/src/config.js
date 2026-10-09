// Public deployment settings only. Provider tokens must never go in this file.
export const DEFAULT_CONNECTION = Object.freeze({
  mode: 'unconfigured', // 'unconfigured', 'gateway', or explicitly selected 'demo'
  apiBase: '', // HTTPS URL of your own deployed gateway, with no query or credentials.
});
