'use client';

import React, { createContext, useContext, useMemo, useState, useEffect } from 'react';
import {
  ConnectionProvider,
  WalletProvider,
} from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import {
  BaseSignerWalletAdapter,
  WalletName,
  WalletReadyState,
} from '@solana/wallet-adapter-base';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { SolanaNetwork, ExecutionMode } from '@/types/vacuum';

import '@solana/wallet-adapter-react-ui/styles.css';

const DEVNET_SANDBOX_WALLET_NAME = 'VACUUM Devnet Wallet' as WalletName<'VACUUM Devnet Wallet'>;
const DEVNET_SANDBOX_PUBKEY = new PublicKey('CvyCyfRajUsmVUZFzdc7LymodJHV1AQDWaaZvv6k8eBJ');

/**
 * Built-in Devnet Inspection & Verification Wallet Adapter for environments
 * without browser extensions installed. Connects the verified Devnet user address
 * (`CvyCyfRajUsmVUZFzdc7LymodJHV1AQDWaaZvv6k8eBJ`) for live RPC discovery & UI verification.
 */
class VacuumDevnetWalletAdapter extends BaseSignerWalletAdapter {
  name = DEVNET_SANDBOX_WALLET_NAME;
  url = 'https://solana.com';
  icon =
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiIgZmlsbD0ibm9uZSI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTQiIHN0cm9rZT0iIzIyZDNlZSIgc3Ryb2tlLXdpZHRoPSIzIi8+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iNiIgZmlsbD0iIzg1NGRmZiIvPjwvc3ZnPg==';
  supportedTransactionVersions = new Set(['legacy', 0] as const);

  private _connecting = false;
  private _publicKey: PublicKey | null = null;
  private _readyState: WalletReadyState =
    typeof window !== 'undefined' ? WalletReadyState.Installed : WalletReadyState.Unsupported;

  get publicKey() {
    return this._publicKey;
  }

  get connecting() {
    return this._connecting;
  }

  get readyState() {
    return this._readyState;
  }

  async connect(): Promise<void> {
    if (this.connected || this.connecting) return;
    this._connecting = true;
    try {
      this._publicKey = DEVNET_SANDBOX_PUBKEY;
      this.emit('connect', this._publicKey);
    } finally {
      this._connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    this._publicKey = null;
    this.emit('disconnect');
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    return transaction;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(
    transactions: T[]
  ): Promise<T[]> {
    return transactions;
  }
}

interface VacuumNetworkContextValue {
  network: SolanaNetwork;
  setNetwork: (net: SolanaNetwork) => void;
  mode: ExecutionMode;
  setMode: (mode: ExecutionMode) => void;
  rpcEndpoint: string;
}

const VacuumNetworkContext = createContext<VacuumNetworkContextValue>({
  network: 'devnet',
  setNetwork: () => {},
  mode: 'live',
  setMode: () => {},
  rpcEndpoint: 'https://api.devnet.solana.com',
});

export function useVacuumNetwork() {
  return useContext(VacuumNetworkContext);
}

export function SolanaWalletProvider({ children }: { children: React.ReactNode }) {
  const initialNetwork =
    (process.env.NEXT_PUBLIC_SOLANA_NETWORK as SolanaNetwork) === 'mainnet-beta'
      ? 'mainnet-beta'
      : 'devnet';

  const [network, setNetworkState] = useState<SolanaNetwork>(initialNetwork);
  const [mode, setMode] = useState<ExecutionMode>('live');

  useEffect(() => {
    const savedNet = window.localStorage.getItem('vacuum_solana_network');
    if (savedNet === 'mainnet-beta' || savedNet === 'devnet') {
      setNetworkState(savedNet);
    }
  }, []);

  const setNetwork = (net: SolanaNetwork) => {
    setNetworkState(net);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('vacuum_solana_network', net);
    }
  };

  const rpcEndpoint = useMemo(() => {
    if (network === 'mainnet-beta') {
      return (
        process.env.NEXT_PUBLIC_SOLANA_MAINNET_RPC_URL ||
        'https://api.mainnet-beta.solana.com'
      );
    }
    return (
      process.env.NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL ||
      'https://api.devnet.solana.com'
    );
  }, [network]);

  // Wallet Standard wallets (Phantom, Solflare, Backpack, etc.) are automatically
  // registered alongside explicit adapters. The Devnet sandbox adapter is strictly
  // restricted to devnet and never exposed on mainnet-beta.
  const wallets = useMemo(
    () =>
      network === 'devnet'
        ? [
            new PhantomWalletAdapter(),
            new SolflareWalletAdapter(),
            new VacuumDevnetWalletAdapter(),
          ]
        : [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [network]
  );

  return (
    <VacuumNetworkContext.Provider
      value={{
        network,
        setNetwork,
        mode,
        setMode,
        rpcEndpoint,
      }}
    >
      <ConnectionProvider endpoint={rpcEndpoint}>
        <WalletProvider wallets={wallets} autoConnect>
          <WalletModalProvider>{children}</WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </VacuumNetworkContext.Provider>
  );
}
