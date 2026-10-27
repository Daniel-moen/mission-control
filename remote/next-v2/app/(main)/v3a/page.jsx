'use client';

import dynamic from 'next/dynamic';

// Task 0445 direction A — "Lens" (spatial glass). Client-only, like v2's page.
const Page = dynamic(() => import('../../../../app/v3/a/index.jsx'), { ssr: false });
export default Page;
