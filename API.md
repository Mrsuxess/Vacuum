# VACUUM Backend API Specification (`API.md`)

All backend orchestration routes are implemented under `src/app/api/*` using Next.js App Router Route Handlers.

---

## 1. `GET /api/status`

Returns active network configuration, supported consolidation destinations (`$VACUUM`, `SOL`, `USDC`), `$VACUUM` feature-flag status, Jupiter Swap API V2 status, and Gasless Sponsorship policy metrics.

### Query Parameters
- `network`: `"devnet"` | `"mainnet-beta"` (default: `"devnet"`)

### Response (`200 OK`)
```json
{
  "ok": true,
  "network": "devnet",
  "rpcEndpointConfigured": true,
  "destinations": [
    {
      "symbol": "VACUUM",
      "name": "VACUUM Protocol Token",
      "mintAddress": null,
      "decimals": 6,
      "isFlagship": true,
      "isConfiguredForNetwork": false
    }
  ],
  "jupiter": {
    "version": "v2",
    "orderEndpoint": "https://api.jup.ag/swap/v2/order",
    "executeEndpoint": "https://api.jup.ag/swap/v2/execute",
    "hasApiKey": false
  },
  "sponsorship": {
    "enabled": true,
    "isConfigured": true
  }
}
```

---

## 2. `POST /api/discover`

Discovers SPL Token (`TOKEN_PROGRAM_ID`) and Token-2022 (`TOKEN_2022_PROGRAM_ID`) accounts for a connected Solana wallet, evaluates token risk signals, fetches USD prices, and classifies potential vs. recoverable dust.

### Request Body
```json
{
  "walletAddress": "7xKX...9b2P",
  "network": "devnet",
  "mode": "live",
  "maxUsdValue": 5.0
}
```

---

## 3. `POST /api/sweep/quote`

Creates a persisted `SweepSession`, fetches executable quotes (via Jupiter Swap API V2 `/swap/v2/order` on Mainnet or native SPL consolidation on Devnet), evaluates Gasless Sponsorship eligibility, and groups instructions into safe `TransactionBatch` payloads.

### Request Body
```json
{
  "walletAddress": "7xKX...9b2P",
  "network": "devnet",
  "mode": "live",
  "destinationSymbol": "SOL",
  "slippageBps": 100,
  "requestGaslessSponsorship": true,
  "selectedAssets": []
}
```

---

## 4. `POST /api/sweep/execute`

Executes an explicitly authorized `TransactionBatch`.
- In `live` mode, requires `userSignedTransactionBase64`.
- If `sponsorshipApplied` is true, co-signs server-side with the designated fee-payer keypair.
- Submits via Jupiter Swap API V2 `POST /swap/v2/execute` (when `jupiterRequestId` is present) or broadcasts to the Solana RPC and verifies on-chain confirmation before marking the batch `CONFIRMED`.

### Request Body
```json
{
  "sessionId": "vac_4f8a9c12e01b3d22",
  "batchId": "vac_4f8a9c12e01b3d22-batch-1",
  "userSignedTransactionBase64": "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA..."
}
```

---

## 5. `GET /api/history`

Returns historical sweep sessions, platform/wallet analytics, or a specific `SweepReceipt`.

### Query Parameters
- `walletAddress` (optional): Filter history and analytics for a specific wallet.
- `sessionId` (optional): Return the SHA-256 verifiable `SweepReceipt` for a specific session.
