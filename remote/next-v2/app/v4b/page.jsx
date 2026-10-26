'use client';

import dynamic from 'next/dynamic';

// Task 0446 direction B — "Atlas" (zoomable rooms). Client-only, like v2's page.
const Page = dynamic(() => import('../../../app/v4/b/index.jsx'), { ssr: false });
export default Page;
