'use client';

import React, { useState, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { LandingPage } from '@/components/LandingPage';
import { SweepDashboard } from '@/components/SweepDashboard';
import { useVacuumNetwork } from '@/components/SolanaWalletProvider';

export default function HomePage() {
  const { connected } = useWallet();
  const { setVisible: setWalletModalVisible } = useWalletModal();
  const { setMode } = useVacuumNetwork();

  const [view, setView] = useState<'LANDING' | 'DASHBOARD'>('LANDING');

  useEffect(() => {
    if (connected) {
      setMode('live');
      setView('DASHBOARD');
    }
  }, [connected, setMode]);

  const handleConnectWallet = () => {
    if (connected) {
      setMode('live');
      setView('DASHBOARD');
    } else {
      setWalletModalVisible(true);
    }
  };

  const handleExploreDemo = () => {
    setMode('demo');
    setView('DASHBOARD');
  };

  if (view === 'DASHBOARD') {
    return <SweepDashboard onBackToLanding={() => setView('LANDING')} />;
  }

  return (
    <LandingPage
      onConnectWallet={handleConnectWallet}
      onExploreDemo={handleExploreDemo}
    />
  );
}
