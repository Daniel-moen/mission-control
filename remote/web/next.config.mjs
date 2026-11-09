// Panel v6 (task 0612): a Next.js App Router app exported as static files and
// served by the relay (server.js) at /v6 — no Next server runs anywhere.
// assetPrefix /v6 keeps its chunks under dist/v6/_next, clear of v1's /assets/.
export default {
  output: 'export',
  assetPrefix: '/v6',
  trailingSlash: false,
  reactStrictMode: false, // the store owns module-level sockets/timers
  images: { unoptimized: true },
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  env: { NEXT_PUBLIC_MC_BUILD: process.env.MC_BUILD || 'dev' },
};
