'use client';

import dynamic from 'next/dynamic';

// Task 0446 direction C — "Now" (a stack of moments). Client-only, like v2's page.
const Page = dynamic(() => import('../../../app/v4/c/index.jsx'), { ssr: false });
export default Page;
