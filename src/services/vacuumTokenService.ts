import { PublicKey } from '@solana/web3.js';
import {
  DestinationAsset,
  DestinationSymbol,
  SolanaNetwork,
} from '@/types/vacuum';
import {
  getAppConfig,
  SOL_MINT_ADDRESS,
  USDC_DEVNET_MINT,
  USDC_MAINNET_MINT,
} from '@/lib/config';

export class VacuumTokenService {
  /**
   * Returns all supported destination assets for the active network.
   * $VACUUM is always the flagship #1 option, and its mint address is strictly
   * separated between Mainnet and Devnet without cross-network fallback.
   */
  static getSupportedDestinations(network: SolanaNetwork): DestinationAsset[] {
    const config = getAppConfig();
    const rawVacuumMint =
      network === 'mainnet-beta'
        ? config.vacuumToken.mainnetMint
        : config.vacuumToken.devnetMint;

    const validVacuumMint = this.validateMintAddress(rawVacuumMint);

    const vacuumAsset: DestinationAsset = {
      symbol: 'VACUUM',
      name: 'VACUUM Protocol Token',
      mintAddress: validVacuumMint,
      decimals: config.vacuumToken.decimals,
      logoType: 'vacuum-vortex',
      isFlagship: true,
      isConfiguredForNetwork: Boolean(validVacuumMint),
      badgeText: 'FLAGSHIP',
      statusNote: validVacuumMint
        ? `Configured on ${network} (${validVacuumMint.slice(0, 4)}...${validVacuumMint.slice(-4)})`
        : network === 'mainnet-beta'
          ? 'Official Mainnet Mint Pending Launch — Set NEXT_PUBLIC_VACUUM_TOKEN_MINT when deployed'
          : 'Devnet Mint Unconfigured — Set NEXT_PUBLIC_VACUUM_DEVNET_MINT or use SOL/USDC',
    };

    const solAsset: DestinationAsset = {
      symbol: 'SOL',
      name: 'Wrapped / Native SOL',
      mintAddress: SOL_MINT_ADDRESS,
      decimals: 9,
      logoType: 'solana',
      isFlagship: false,
      isConfiguredForNetwork: true,
      badgeText: 'NATIVE LIQUIDITY',
      statusNote: 'Deepest DEX routing liquidity across Solana',
    };

    const usdcAsset: DestinationAsset = {
      symbol: 'USDC',
      name: 'USD Coin',
      mintAddress: network === 'mainnet-beta' ? USDC_MAINNET_MINT : USDC_DEVNET_MINT,
      decimals: 6,
      logoType: 'usdc',
      isFlagship: false,
      isConfiguredForNetwork: true,
      badgeText: 'STABLE',
      statusNote: network === 'mainnet-beta' ? 'Circle Mainnet USDC' : 'Devnet SPL USDC',
    };

    return [vacuumAsset, solAsset, usdcAsset];
  }

  /**
   * Returns the default destination asset for the active network.
   * Defaults to $VACUUM when its legitimate mint address is configured,
   * otherwise defaults to SOL while keeping $VACUUM prominently selectable in Demo or once configured.
   */
  static getDefaultDestination(network: SolanaNetwork, isDemo: boolean = false): DestinationAsset {
    const destinations = this.getSupportedDestinations(network);
    const vacuum = destinations.find((d) => d.symbol === 'VACUUM')!;
    if (vacuum.isConfiguredForNetwork || isDemo) {
      return vacuum;
    }
    return destinations.find((d) => d.symbol === 'SOL')!;
  }

  static getDestinationBySymbol(
    symbol: DestinationSymbol,
    network: SolanaNetwork
  ): DestinationAsset {
    const destinations = this.getSupportedDestinations(network);
    const found = destinations.find((d) => d.symbol === symbol);
    if (!found) {
      throw new Error(`Unsupported destination symbol: ${symbol}`);
    }
    return found;
  }

  static validateMintAddress(mint: string | null | undefined): string | null {
    if (!mint || mint.trim().length === 0) return null;
    try {
      const pubkey = new PublicKey(mint.trim());
      return pubkey.toBase58();
    } catch {
      return null;
    }
  }

  /**
   * Planned $VACUUM utility feature flags and status.
   * Explicitly distinguishes planned ecosystem utilities from live verified features.
   */
  static getTokenUtilityStatus(network: SolanaNetwork) {
    const config = getAppConfig();
    const vacuumDest = this.getDestinationBySymbol('VACUUM', network);

    return {
      tokenSymbol: '$VACUUM',
      network,
      mintConfigured: vacuumDest.isConfiguredForNetwork,
      mintAddress: vacuumDest.mintAddress,
      utilities: [
        {
          id: 'fee-discount',
          title: 'Reduced Platform Service Fees',
          description: 'Eligible $VACUUM holders receive reduced platform orchestration fees on multi-asset sweeps.',
          enabled: config.vacuumToken.features.feeDiscount && vacuumDest.isConfiguredForNetwork,
          statusLabel:
            config.vacuumToken.features.feeDiscount && vacuumDest.isConfiguredForNetwork
              ? 'ACTIVE'
              : 'PLANNED UTILITY (FEATURE FLAG DISABLED)',
        },
        {
          id: 'pro-limits',
          title: 'Premium Sweeping Batch Limits',
          description: 'Higher per-session batch allowances and priority sponsorship queue access.',
          enabled: config.vacuumToken.features.proTier && vacuumDest.isConfiguredForNetwork,
          statusLabel:
            config.vacuumToken.features.proTier && vacuumDest.isConfiguredForNetwork
              ? 'ACTIVE'
              : 'PLANNED UTILITY (FEATURE FLAG DISABLED)',
        },
        {
          id: 'auto-sweep',
          title: 'Scheduled Auto-Sweep Scans',
          description: 'Recurring background dust discovery with explicit wallet signing prompts.',
          enabled: config.vacuumToken.features.autoSweep,
          statusLabel: config.vacuumToken.features.autoSweep
            ? 'ACTIVE'
            : 'PLANNED UTILITY (FEATURE FLAG DISABLED)',
        },
      ],
    };
  }
}
