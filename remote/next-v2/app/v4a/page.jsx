'use client';

import dynamic from 'next/dynamic';

// Task 0446 direction A — "Stage" (Mia-first canvas). Client-only, like v2's page.
const Page = dynamic(() => import('../../../app/v4/a/index.jsx'), { ssr: false });
export default Page;
