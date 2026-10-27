'use client';

import dynamic from 'next/dynamic';

// Task 0491 — v5.2: chat first, a glass side panel for everything else. Client-only, like v5.
const Boot = dynamic(() => import('../../../../app/v52/boot.jsx'), { ssr: false });

export default function Page() {
  return <Boot />;
}
