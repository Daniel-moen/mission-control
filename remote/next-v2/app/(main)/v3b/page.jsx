'use client';

import dynamic from 'next/dynamic';

// Task 0445 direction B — "Presence" (Mia, alive). Client-only, like v2's page.
const Page = dynamic(() => import('../../../../app/v3/b/index.jsx'), { ssr: false });
export default Page;
