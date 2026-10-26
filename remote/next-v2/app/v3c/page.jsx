'use client';

import dynamic from 'next/dynamic';

// Task 0445 direction C — "Press" (kinetic editorial). Client-only, like v2's page.
const Page = dynamic(() => import('../../../app/v3/c/index.jsx'), { ssr: false });
export default Page;
