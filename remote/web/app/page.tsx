'use client';
import dynamic from 'next/dynamic';

// The panel is client-only (sockets, localStorage). The static HTML already
// paints the scene colour, so first paint matches the app — no flash.
const Panel = dynamic(() => import('@/views/Panel'), { ssr: false });

export default function Page() {
  return <Panel />;
}
