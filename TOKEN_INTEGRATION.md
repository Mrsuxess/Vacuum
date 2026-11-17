# `$VACUUM` Token Integration Guide (`TOKEN_INTEGRATION.md`)

## 1. Design Philosophy

The VACUUM application is engineered to operate independently of the final `$VACUUM` token launch while making `$VACUUM` the flagship consolidation destination.

- **No Invented Mint Addresses**: In compliance with security and integrity rules, VACUUM never hardcodes an unverified or placeholder mainnet mint address.
- **Zero-Rewrite Launch Activation**: Activating `$VACUUM` as the live default mainnet destination requires only setting environment variables—no code rewrite is needed.

---

## 2. Configuring the Official `$VACUUM` Mint

When the official `$VACUUM` token is deployed on Solana Mainnet-Beta:

1. Verify the mint address, decimals, and authority status on Solscan.
2. Add the verified configuration to your production environment:
   ```env
   NEXT_PUBLIC_VACUUM_TOKEN_MINT=<OFFICIAL_VERIFIED_MAINNET_MINT_ADDRESS>
   NEXT_PUBLIC_VACUUM_TOKEN_DECIMALS=6
   NEXT_PUBLIC_VACUUM_TOKEN_SYMBOL=VACUUM
   ```
3. Once `NEXT_PUBLIC_VACUUM_TOKEN_MINT` is set and valid:
   - `VacuumTokenService.getSupportedDestinations('mainnet-beta')` automatically marks `$VACUUM` as `isConfiguredForNetwork: true`.
   - `VacuumTokenService.getDefaultDestination('mainnet-beta')` automatically selects `$VACUUM` as the default destination.
   - `QuoteService` routes swaps directly to the configured `$VACUUM` mint via Jupiter Swap API V2 (`/swap/v2/order`).

---

## 3. Planned Utility Feature Flags

Planned token utilities are controlled via explicit feature flags so unlaunched features are never misrepresented as active:

| Feature Flag | Planned Utility | Default |
| :--- | :--- | :--- |
| `FEATURE_VACUUM_FEE_DISCOUNT` | Reduced platform service fees for verified `$VACUUM` holders | `false` |
| `FEATURE_VACUUM_PRO_TIER` | Higher per-session batch allowances and priority sponsorship queue | `false` |
| `FEATURE_AUTO_SWEEP` | Recurring wallet dust scans with explicit signing notifications | `false` |
