# Testing & Quality Assurance (`TESTING.md`)

## 1. Running the Automated Test Suite

Run all unit, integration, and E2E workflow tests using Vitest:

```bash
npm test
```

### Unit Tests (`tests/unit/vacuum-core.test.ts`)
Covers:
- Token balance normalization (`0–18` decimals) and raw integer conversion.
- USD valuation and null/unpriced token handling.
- Token risk assessment (`TokenRiskService`) — verifying that phishing URLs in metadata are quarantined (`CRITICAL`).
- Dust classification (`LiquidityService`) — verifying separation between **Valuable Holdings**, **Recoverable Dust**, and **Unroutable Dust**.
- Quote validation (`JupiterService.validateOrderQuote`) — testing price impact thresholds and quote expiration.
- Intelligent batch grouping (`TransactionBatcher.groupQuoteItemsIntoBatches`) — verifying that 34 swaps are split across multiple safe batches respecting Solana's `1,232-byte` limit.
- Sponsorship economic eligibility (`SponsorshipService.evaluateSponsorshipEligibility`).
- Batch status transitions (`COMPLETED`, `PARTIAL_SUCCESS`, `FAILED`).
- `$VACUUM` mint integrity (verifying no fake mainnet mint is ever invented when `NEXT_PUBLIC_VACUUM_TOKEN_MINT` is unset).

### Integration & E2E Workflow Tests (`tests/integration/sweep-workflow.test.ts`)
Covers:
- Wallet registration and base58 address validation without storing private keys.
- Dual cryptographic signing (`VersionedTransaction` v0 signed by both User wallet and Server Sponsor fee-payer wallet).
- Complete 10-step E2E sweep journey with failure isolation, database persistence, and SHA-256 receipt verification.
- Rejection of unsigned live execution requests.

---

## 2. Running Live Solana Devnet Verification

To test real cryptographic dual-signing and RPC simulation against Solana Devnet (`https://api.devnet.solana.com`):

```bash
npm run test:devnet
```
