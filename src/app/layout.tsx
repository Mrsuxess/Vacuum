import type { Metadata } from 'next';
import './globals.css';
import { SolanaWalletProvider } from '@/components/SolanaWalletProvider';

export const metadata: Metadata = {
  title: 'VACUUM — Clear the Clutter. Keep the Value. | Solana Dust Sweeper',
  description:
    'VACUUM is a Solana-based wallet-cleaning and asset-consolidation platform. Discover accumulated token dust, reclaim SPL account rent, and sweep eligible assets into $VACUUM, SOL, or USDC.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased bg-obsidian-950 text-slate-100">
        <SolanaWalletProvider>{children}</SolanaWalletProvider>
      </body>
    </html>
  );
}
