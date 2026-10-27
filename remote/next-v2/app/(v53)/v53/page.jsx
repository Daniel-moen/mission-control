'use client';

import dynamic from 'next/dynamic';

// Task 0502 — v5.3: chat first, Liquid Glass, a bottom tab bar. Client-only, like v5.
const Boot = dynamic(() => import('../../../../app/v53/boot.jsx'), { ssr: false });

export default function Page() {
  return <Boot />;
}
