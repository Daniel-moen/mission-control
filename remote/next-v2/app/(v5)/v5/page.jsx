'use client';

import dynamic from 'next/dynamic';

// Task 0483 — v5: v1's structure in v4's Lens glass. Client-only, like v2's page.
const Boot = dynamic(() => import('../../../../app/v5/boot.jsx'), { ssr: false });

export default function Page() {
  return <Boot />;
}
