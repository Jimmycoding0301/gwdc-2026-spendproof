const privateVariables = new Set([
  'KILN_API_KEY', 'TESTNET_PRIVATE_KEY', 'GASFREE_API_KEY', 'GASFREE_API_SECRET',
  // Prevent inherited preload flags or HTTP diagnostics from loading/logging secrets.
  'NODE_OPTIONS', 'NODE_DEBUG', 'SPENDPROOF_ENGINE',
]);

/** Inherit runtime basics, excluding credentials; overrides are explicit test fixtures. */
export function childTestEnv(overrides: NodeJS.ProcessEnv = {}, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(source)) {
    if (!privateVariables.has(name)) env[name] = source[name];
  }
  return { ...env, ...overrides };
}
