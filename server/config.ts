import { z } from 'zod';

const env = z.object({
  KILN_API_KEY: z.string().optional(),
  KILN_BASE_URL: z.url().default('https://api.bricksum.com/v1'),
  KILN_MODEL: z.string().min(1).max(200).default('qwen3-32b'),
  KILN_MAX_TOKENS: z.coerce.number().int().min(256).max(8192).default(4096),
  ENABLE_TESTNET_ANCHOR: z.enum(['true', 'false']).default('false'),
  BASE_SEPOLIA_RPC_URL: z.url().default('https://sepolia.base.org'),
  TESTNET_PRIVATE_KEY: z.string().optional(),
}).parse(process.env);

const kilnUrl = new URL(env.KILN_BASE_URL);
if (kilnUrl.protocol !== 'https:' && !(kilnUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(kilnUrl.hostname))) {
  throw new Error('KILN_BASE_URL must use HTTPS, or HTTP on localhost for tests.');
}
if (kilnUrl.username || kilnUrl.password || kilnUrl.search || kilnUrl.hash) throw new Error('KILN_BASE_URL must not contain credentials, query, or hash.');

export const config = {
  port: 8787,
  kilnApiKey: env.KILN_API_KEY?.trim() || '',
  kilnBaseUrl: env.KILN_BASE_URL.replace(/\/$/, ''),
  kilnModel: env.KILN_MODEL,
  kilnMaxTokens: env.KILN_MAX_TOKENS,
  anchorEnabled: env.ENABLE_TESTNET_ANCHOR === 'true',
  rpcUrl: env.BASE_SEPOLIA_RPC_URL,
  testnetPrivateKey: env.TESTNET_PRIVATE_KEY || '',
};

export const anchorConfigured = () => config.anchorEnabled && /^0x[0-9a-fA-F]{64}$/.test(config.testnetPrivateKey);
