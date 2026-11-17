'use client';

import React from 'react';

interface LogoProps {
  className?: string;
  size?: number;
}

/**
 * Original VACUUM Vortex / Orbital Suction SVG Identity.
 * Designed around concentric event-horizon rings and ultraviolet-to-cyan vector gradients.
 */
export function VacuumLogo({ className = '', size = 36 }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="VACUUM Logo"
    >
      <defs>
        <linearGradient id="vacuum-vortex-grad" x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#A855F7" />
          <stop offset="55%" stopColor="#7C3AED" />
          <stop offset="100%" stopColor="#22D3EE" />
        </linearGradient>
        <radialGradient id="vacuum-core-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#22D3EE" stopOpacity="0.9" />
          <stop offset="60%" stopColor="#8B5CF6" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#05060B" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Outer orbital suction arc */}
      <circle
        cx="24"
        cy="24"
        r="20"
        stroke="url(#vacuum-vortex-grad)"
        strokeWidth="2.2"
        strokeDasharray="88 38"
        strokeLinecap="round"
      />

      {/* Middle vortex spiral */}
      <path
        d="M36.5 17.5C33.8 11.8 27.2 8.8 20.6 10.4C14.0 12.0 9.6 18.2 10.4 25.0C11.2 31.8 16.8 36.8 23.6 36.8C29.2 36.8 33.8 33.2 35.4 28.0"
        stroke="url(#vacuum-vortex-grad)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {/* Inner event-horizon V-singularity */}
      <path
        d="M17.5 18.5L24 30.5L30.5 18.5"
        stroke="#F8FAFC"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Core singularity point */}
      <circle cx="24" cy="21" r="2.6" fill="#22D3EE" />
      <circle cx="24" cy="24" r="14" fill="url(#vacuum-core-glow)" opacity="0.25" />
    </svg>
  );
}

export function DestinationTokenIcon({
  symbol,
  size = 28,
}: {
  symbol: 'VACUUM' | 'SOL' | 'USDC' | string;
  size?: number;
}) {
  if (symbol === 'VACUUM') {
    return <VacuumLogo size={size} />;
  }

  if (symbol === 'SOL') {
    return (
      <svg width={size} height={size} viewBox="0 0 36 36" fill="none">
        <circle cx="18" cy="18" r="18" fill="#0E1220" stroke="#1F2744" />
        <path
          d="M10.5 23.2C10.7 23.0 11.0 22.8 11.4 22.8H26.8C27.4 22.8 27.7 23.5 27.3 23.9L25.5 25.8C25.3 26.0 25.0 26.2 24.6 26.2H9.2C8.6 26.2 8.3 25.5 8.7 25.1L10.5 23.2Z"
          fill="#22D3EE"
        />
        <path
          d="M10.5 10.2C10.7 10.0 11.0 9.8 11.4 9.8H26.8C27.4 9.8 27.7 10.5 27.3 10.9L25.5 12.8C25.3 13.0 25.0 13.2 24.6 13.2H9.2C8.6 13.2 8.3 12.5 8.7 12.1L10.5 10.2Z"
          fill="#A855F7"
        />
        <path
          d="M25.5 16.6C25.3 16.4 25.0 16.2 24.6 16.2H9.2C8.6 16.2 8.3 16.9 8.7 17.3L10.5 19.2C10.7 19.4 11.0 19.6 11.4 19.6H26.8C27.4 19.6 27.7 18.9 27.3 18.5L25.5 16.6Z"
          fill="#8B5CF6"
        />
      </svg>
    );
  }

  if (symbol === 'USDC' || symbol.startsWith('USDC')) {
    return (
      <svg width={size} height={size} viewBox="0 0 36 36" fill="none">
        <circle cx="18" cy="18" r="18" fill="#172554" stroke="#2563EB" />
        <text
          x="18"
          y="22.5"
          textAnchor="middle"
          fill="#60A5FA"
          fontSize="13"
          fontWeight="700"
          fontFamily="monospace"
        >
          $
        </text>
      </svg>
    );
  }

  const initials = symbol.slice(0, 3).toUpperCase();
  return (
    <div
      style={{ width: size, height: size }}
      className="rounded-full bg-obsidian-800 border border-obsidian-700 flex items-center justify-center text-[10px] font-mono font-semibold text-slate-300 shrink-0"
    >
      {initials}
    </div>
  );
}
