# VACUUM ($VACUUM)
## Clear the Clutter. Keep the Value. — The Solana Wallet Dust Sweeper

**VACUUM** is a non-custodial Solana wallet-cleaning and asset-consolidation platform. Active Solana wallets accumulate forgotten tokens, abandoned memecoins, micro-balances, and empty SPL token accounts locking up recoverable SOL rent (`~0.00203928 SOL` per account).

VACUUM connects to any Solana Wallet Standard wallet (Phantom, Solflare, Backpack), discovers SPL Token and Token-2022 accounts, evaluates liquidity and security risk signals, and consolidates eligible dust into **$VACUUM**, **SOL**, or **USDC** using **Jupiter Swap API V2** (`/swap/v2/order` and `/swap/v2/execute`), intelligent transaction batching, and an economically sustainable **Gasless Fee Sponsorship** engine.

---

## Core Capabilities

1. **Solana Wallet Standard Integration**: Supports Phantom, Solflare, and compatible wallets across `devnet` and `mainnet-beta` with strict network mismatch protection.
2. **Real Token & Rent Discovery Engine**: Queries `TOKEN_PROGRAM_ID` and `TOKEN_2022_PROGRAM_ID` accounts, normalizes balances, inspects on-chain mint/freeze authorities, and distinguishes **Potential Dust Value** from **Actually Recoverable Value**.
3. **Configurable Dust Classification**: Interactive presets (`Under $0.10`, `Under $0.50`, `Under $1.00`, `Under $5.00`, `Under $10.00`, or custom USD threshold).
4. **Jupiter Swap API V2 Meta-Aggregation**: Integrates `GET /swap/v2/order` and `POST /swap/v2/execute` with slippage validation, quote freshness checks, and integrator fee-payer support.
5. **Intelligent Transaction Batcher & Failure Isolation**: Groups instructions within Solana's `1,232-byte` packet limit, `64-account` cap, and `1,400,000 CU` ceiling. One illiquid or failed token never blocks remaining eligible assets.
6. **Gasless Transaction Sponsorship**: Server-side designated fee-payer service (`SponsorshipService`) that calculates net economic recovery before co-signing transactions within per-wallet and daily sponsorship budgets.
7. **Security & Token Risk Layer**: Evaluates mint authority, freeze authority, Token-2022 transfer hooks/fees, price impact, and phishing metadata before constructing transactions.
8. **Verifiable History & Exportable Receipts**: Tracks every session, batch, and signature with Solscan explorer links and SHA-256 verifiable JSON receipts.

---

## Quick Start

### Prerequisites
- **Node.js**: v22.5+ (tested on Node `v26.7.0` with native `node:sqlite`)
- **npm**: v10+

### Installation
```bash
npm install --legacy-peer-deps --ignore-scripts
cp .env.example .env.local
```

### Development Server
```bash
npm run dev
```

### Production Build
```bash
npm run build
npm start
```

### Automated Tests & Devnet Verification
```bash
npm test
npm run test:devnet
```

---

## Documentation Index

- [ARCHITECTURE.md](./ARCHITECTURE.md) — System design, service boundaries, and database schema
- [SECURITY.md](./SECURITY.md) — Threat model, token risk assessment, and fee-payer controls
- [ENVIRONMENT.md](./ENVIRONMENT.md) — Environment variables and external API credentials
- [API.md](./API.md) — Backend REST API specification
- [DEVELOPMENT.md](./DEVELOPMENT.md) — Local development workflow and module guide
- [DEPLOYMENT.md](./DEPLOYMENT.md) — Production deployment checklist
- [TESTING.md](./TESTING.md) — Unit, integration, E2E, and Devnet verification guide
- [TOKEN_INTEGRATION.md](./TOKEN_INTEGRATION.md) — `$VACUUM` flagship token configuration and feature flags
