# GWDC 2026 Korea submission

| Field | Value |
|---|---|
| Ecosystem / Challenge | FuriosaAI × Bricksum |
| Project | SpendProof |
| Repository name | `gwdc-2026-spendproof` |
| Team name | **TODO: team leader** |
| Team leader | **TODO: team leader** |
| Contact email | **TODO: personal submission email** |
| Telegram | **TODO: Telegram handle** |
| Repository URL | <https://github.com/Jimmycoding0301/gwdc-2026-spendproof> |
| Demo video, ≤3 minutes | <https://github.com/Jimmycoding0301/gwdc-2026-spendproof/raw/refs/heads/main/docs/submission/demo.mp4> |
| Pitch deck | <https://github.com/Jimmycoding0301/gwdc-2026-spendproof/raw/refs/heads/main/docs/submission/pitch-deck.pptx> |
| Local demo | `npm ci && npm run dev` → <http://127.0.0.1:5173> |

## Short description

**English:** SpendProof is payment-policy CI for AI agents. It turns invoice evidence into a reviewable proposal, replays saved incidents against candidate rules, produces deterministic boundary tests, and exports a receipt that finance, security and CI can independently verify.

**中文：** SpendProof 是 AI 付款规则的发布前检查工具：截图生成草稿，确定性规则核验付款提案，用历史事故让错误规则亮红灯，再导出可独立复算的收据和 CI 回归案例。

## Challenge use

- `qwen3-32b` is called through the Kiln OpenAI-compatible API when configured.
- The model proposes tool actions; deterministic code decides authorization.
- Fixture mode remains usable without a key and is always labeled.

## Evidence and validation

- Base Sepolia: <https://sepolia.basescan.org/tx/0x10f68d330eca7baca5cee9c4a74cdc4b7732a43933021f3db7e0297fb68ce25a>
- Public JSON: [docs/evidence/base-sepolia-anchor.json](docs/evidence/base-sepolia-anchor.json)
- Verification record: [docs/verification.md](docs/verification.md)
- Clean-package validation: `npm ci` passed; 180 tests passed, one platform-conditional test skipped; production build and SDK regression passed.
- Commands: `npm test`, `npm run build`, `node --import tsx examples/sdk-regression.ts`

## Disclosure

Supplier payments remain simulated. The chain transaction is a zero-value evidence anchor. See [HACKATHON_SCOPE.md](HACKATHON_SCOPE.md) and [SECURITY.md](SECURITY.md).

No open-source license has been selected. The public repository is available to reviewers without sign-in.
