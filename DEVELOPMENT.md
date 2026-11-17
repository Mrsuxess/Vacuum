# Development Guide (`DEVELOPMENT.md`)

## 1. Local Setup

1. Install dependencies:
   ```bash
   npm install --legacy-peer-deps --ignore-scripts
   ```
2. Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```
3. Start the Next.js development server:
   ```bash
   npm run dev
   ```
4. Open `http://localhost:3000`.

---

## 2. Project Directory Structure

```text
/home/suxess/Desktop/VACUUM
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── discover/route.ts
│   │   │   ├── history/route.ts
│   │   │   ├── status/route.ts
│   │   │   └── sweep/
│   │   │       ├── quote/route.ts
│   │   │       └── execute/route.ts
│   │   ├── globals.css
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── components/
│   │   ├── LandingPage.tsx
│   │   ├── SolanaWalletProvider.tsx
│   │   ├── SweepDashboard.tsx
│   │   ├── SweepReviewModal.tsx
│   │   └── VacuumLogo.tsx
│   ├── lib/
│   │   ├── config.ts
│   │   └── db.ts
│   ├── services/
│   │   ├── analyticsService.ts
│   │   ├── historyService.ts
│   │   ├── jupiterService.ts
│   │   ├── liquidityService.ts
│   │   ├── pricingService.ts
│   │   ├── quoteService.ts
│   │   ├── sponsorshipService.ts
│   │   ├── sweepOrchestrator.ts
│   │   ├── tokenDiscoveryService.ts
│   │   ├── tokenRiskService.ts
│   │   ├── transactionBatcher.ts
│   │   ├── transactionVerificationService.ts
│   │   ├── vacuumTokenService.ts
│   │   └── walletService.ts
│   └── types/
│       └── vacuum.ts
├── scripts/
│   └── verify-devnet-sponsorship.ts
└── tests/
    ├── unit/vacuum-core.test.ts
    └── integration/sweep-workflow.test.ts
```

---

## 3. Architectural Conventions

- **Keep Business Logic Out of React Components**: Components in `src/components/*` strictly render state and invoke structured API endpoints (`/api/*`) and wallet adapters.
- **Explicit Mode Separation**: Always preserve the distinction between `mode: 'live'` (real RPC & wallet signatures) and `mode: 'demo'` (explicitly labeled interactive preview).
