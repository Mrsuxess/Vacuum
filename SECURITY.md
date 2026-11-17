# VACUUM Security & Token Safety Architecture (Phase 9 Hardened)

## 1. Core Security Principles

1. **Strictly Non-Custodial**: VACUUM never requests, accepts, logs, or stores user private keys or seed phrases.
2. **Server-Isolated Sponsor Credentials**: `SPONSOR_FEE_PAYER_SECRET_KEY` is accessed strictly inside `src/services/sponsorshipService.ts` on the server and is never prefixed with `NEXT_PUBLIC_` or exposed to client bundles.
3. **Byte-for-Byte Message Integrity & Ed25519 Verification**: Before co-signing or broadcasting any live transaction in `TransactionVerificationService.verifySignedTransactionIntegrity`, the backend verifies that:
   - The serialized `VersionedTransaction.message` submitted by the client is byte-for-byte identical to the unsigned batch transaction constructed on the server (`expectedUnsignedTxBase64`), preventing instruction or account tampering.
   - The session owner wallet (`session.walletAddress`) is a required signer and holds a cryptographically valid Ed25519 signature (`crypto.verify` via OpenSSL/SPKI) over the transaction message.
4. **Sponsor Instruction Safety Guardrails (`validateSponsorInstructionSafety`)**: Even if `staticAccountKeys[0]` is the sponsor public key, the backend inspects every compiled instruction and strictly forbids the sponsor from being the funding source of direct `SystemProgram` transfers/creations or the owner/authority of any `TOKEN_PROGRAM_ID` / `TOKEN_2022_PROGRAM_ID` `Transfer`, `Burn`, `CloseAccount`, `Approve`, or `SetAuthority` instruction.
5. **Network Mismatch & Mainnet Safety Boundaries**: Devnet and Mainnet configurations are strictly isolated (`VacuumTokenService` never falls back across networks, and `TransactionBatcher` forbids `BurnChecked` consolidation on `mainnet-beta`).

---

## 2. Token Risk Assessment & Token-2022 Safety (`TokenRiskService`)

Before any token can be quoted or swept, `QuoteService` re-evaluates `TokenRiskService.assessTokenRisk` on the server (never trusting client-submitted risk flags):

- **Frozen Accounts (`CRITICAL`)**: Detects `state === 'frozen'` on token accounts and blocks sweeping (`canSweepSafely = false`).
- **Token-2022 Non-Transferable / Soulbound (`CRITICAL`)**: Blocks non-transferable Token-2022 extensions.
- **Token-2022 Unharvested Withheld Transfer Fees (`CRITICAL`)**: Blocks direct `CloseAccount` when `transferFeeAmount.withheldAmount > 0`.
- **Phishing / Scam Metadata (`CRITICAL`)**: Quarantines tokens with URLs or claim-bait text in names/symbols.
- **Token-2022 Permanent Delegate & Transfer Hooks (`HIGH`)**: Flags permanent delegates and transfer hooks, elevating `riskLevel` to at least `HIGH` and requiring explicit user acknowledgement.
- **Third-Party Close Authority (`HIGH`)**: Blocks accounts where an external `closeAuthority` is assigned.

---

## 3. Sponsorship Reservation & SOL Flow Accounting

1. **Immediate Budget Reservation (`RESERVED`)**: When `SweepOrchestrator.createSweepSession` approves sponsorship, it atomically inserts `'RESERVED'` rows in `sponsorship_records` inside the SQLite session creation transaction so concurrent sweep sessions cannot bypass `maxPerWalletLamports`, `maxDailyBudgetLamports`, or `rateLimitPerHour`.
2. **Explicit SOL Movement Ownership (`solFlowBreakdown`)**:
   - **Network Base Fee & Priority Fee**: Paid by Sponsor (`VACUUM_SPONSOR_PAYER`) or User (`USER_SELF_PAID`) to Solana validators.
   - **Reclaimed Token-Account Rent (`~0.00203928 SOL`)**: Paid 100% to the **User** (`userPubkey`) in `createCloseAccountInstruction(tokenAccountPubkey, userPubkey, userPubkey, [], tokenProgramId)`. Reclaimed rent is never assumed to belong to the sponsor.
   - **Swap Proceeds**: Sent 100% to the **User**.
   - **Sponsor Recovery**: Accounted as subsidized (`SUBSIDIZED_BY_SPONSOR`) unless `JUPITER_REFERRAL_ACCOUNT` is explicitly configured for on-chain referral fee collection.
