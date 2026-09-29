# Security policy

## Reporting

After the GitHub repository is created, use GitHub's private vulnerability reporting or a private Security Advisory. Do not publish a suspected vulnerability, credential or exploit in a public issue.

## Secrets

- Never commit `.env`, `.data`, wallet files, private keys, API keys, seed phrases or raw business evidence.
- `KILN_API_KEY` and `TESTNET_PRIVATE_KEY` are server-only variables. They must never use the `VITE_` prefix.
- Use a dedicated Base Sepolia wallet with no mainnet assets. Rotate any credential that appears in logs, screenshots, chat or Git history.

## Trust boundary

The model proposes actions; deterministic code authorizes them. Screenshot OCR only produces a draft. The Base Sepolia transaction is an evidence anchor, not a payment or identity proof.

This hackathon prototype is intended for local, single-user evaluation. It has not received a production security audit.

