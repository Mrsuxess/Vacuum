# Environment Configuration Guide (`ENVIRONMENT.md`)

Copy `.env.example` to `.env.local` for local development or configure these variables in your hosting provider.

## Required & Optional Variables

| Variable | Scope | Required | Description |
| :--- | :--- | :--- | :--- |
| `NEXT_PUBLIC_SOLANA_NETWORK` | Public | Yes | Default network (`devnet` or `mainnet-beta`). |
| `SERVER_ENFORCED_NETWORK` | Server | Optional | When set to `devnet` or `mainnet-beta`, locks the server to that network and rejects cross-network requests. |
| `NEXT_PUBLIC_SOLANA_MAINNET_RPC_URL` | Public | Yes | Mainnet-Beta Solana RPC URL. |
| `NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL` | Public | Yes | Devnet Solana RPC URL. |
| `SOLANA_MAINNET_RPC_URL` | Server | Yes | Server-side Mainnet RPC endpoint (recommended: dedicated Helius/Triton/QuickNode URL). |
| `SOLANA_DEVNET_RPC_URL` | Server | Yes | Server-side Devnet RPC endpoint. |
| `JUPITER_API_BASE_URL` | Server | Yes | Defaults to `https://api.jup.ag/swap/v2`. |
| `JUPITER_PRICE_API_URL` | Server | Yes | Defaults to `https://api.jup.ag/price/v3`. |
| `JUPITER_API_KEY` | Server | For Mainnet Live Swaps | API key passed as `x-api-key` to Jupiter Swap API V2 (`/swap/v2/order` & `/swap/v2/execute`) and Price API V3. |
| `NEXT_PUBLIC_VACUUM_TOKEN_MINT` | Public | When `$VACUUM` Launches | Official verified Mainnet mint address for `$VACUUM`. Leave blank until official deployment. |
| `NEXT_PUBLIC_VACUUM_DEVNET_MINT` | Public | Optional | Devnet test SPL mint address for `$VACUUM`. |
| `SPONSOR_MAINNET_FEE_PAYER_SECRET_KEY` | **Server Secret** | For Mainnet Gasless | Dedicated Mainnet fee-payer secret key (never shared with Devnet). |
| `SPONSOR_DEVNET_FEE_PAYER_SECRET_KEY` | **Server Secret** | Optional | Dedicated Devnet fee-payer secret key (or uses `./data/devnet-sponsor-keypair.json`). |
| `MAINNET_SPONSORSHIP_ENABLED` | Server | For Mainnet Gasless | Defaults to `false`. Must be explicitly set to `true` to enable Mainnet sponsorship. |
| `SPONSORSHIP_ENABLED` | Server | Optional | `true` or `false` (default `true`). |
| `SPONSORSHIP_MIN_SWEEP_USD` | Server | Optional | Minimum gross sweep value in USD to qualify for sponsorship (default `0.25`). |
| `SPONSORSHIP_MAX_PER_WALLET_LAMPORTS` | Server | Optional | Max sponsored lamports per wallet per 24h (default `5000000`). |
| `SPONSORSHIP_MAX_DAILY_BUDGET_LAMPORTS` | Server | Optional | Max global sponsored lamports per 24h (default `100000000`). |
| `SPONSORSHIP_MAX_PRIORITY_MICRO_LAMPORTS` | Server | Optional | Max ComputeBudget priority fee price in microLamports/CU allowed on sponsored txs (default `250000`). |
| `DATABASE_PATH` | Server | Optional | Path to SQLite database file (default `./data/vacuum.db`). |
