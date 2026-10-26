'use client';

import dynamic from 'next/dynamic';

// The whole panel is client-side (a live view of the Mac over a WebSocket);
// the static export just ships it. See app/v2/boot.jsx.
const Boot = dynamic(() => import('../../app/v2/boot.jsx'), { ssr: false });

export default function Page() {
  return <Boot />;
}
