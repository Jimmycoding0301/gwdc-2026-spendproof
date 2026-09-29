import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { childTestEnv } from './helpers/child-env';
import { syntheticSecrets } from './helpers/synthetic-secrets';

describe('credential boundaries', () => {
  it('removes inherited secrets from child processes without mutating the source environment', () => {
    const source = { PATH: '/synthetic/runtime', ...syntheticSecrets, NODE_OPTIONS: '--synthetic-preload', NODE_DEBUG: 'http', SPENDPROOF_ENGINE: 'inherited-engine' };
    const env = childTestEnv({ SPENDPROOF_ENGINE: 'explicit-test-engine' }, source);
    const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const inherited = JSON.parse(result.stdout);
    for (const name of Object.keys(syntheticSecrets)) expect(inherited).not.toHaveProperty(name);
    expect(inherited.NODE_OPTIONS).toBeUndefined();
    expect(inherited.NODE_DEBUG).toBeUndefined();
    expect(inherited.SPENDPROOF_ENGINE).toBe('explicit-test-engine');
    expect(inherited.PATH).toBe(source.PATH);
    expect(source.KILN_API_KEY).toBe(syntheticSecrets.KILN_API_KEY);
  });

  for (const mode of ['success', 'http-error', 'malformed', 'network-error', 'body-error', 'model-reflection']) {
    it(`keeps synthetic secrets out of health, sessions, evidence, persistence and logs: ${mode}`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'spendproof-secrets-'));
      try {
        const result = spawnSync(process.execPath, [
          '--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)),
          fileURLToPath(new URL('./fixtures/secrets-api-harness.ts', import.meta.url)), mode,
        ], {
          cwd: directory, encoding: 'utf8', timeout: 20_000,
          env: childTestEnv({ ...syntheticSecrets, ENABLE_TESTNET_ANCHOR: 'false', KILN_BASE_URL: 'http://127.0.0.1:9', KILN_MODEL: 'synthetic-test-model', BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org' }),
        });
        for (const secret of Object.values(syntheticSecrets)) {
          expect(result.stdout + result.stderr).not.toContain(secret);
        }
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(`Synthetic secret checks passed: ${mode}`);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }, 25_000);
  }
});
