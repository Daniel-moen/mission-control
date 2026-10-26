// Panel v2 (task 0444): Next.js App Router, exported as static files and
// served by the relay (server.js) — no Next server runs anywhere.
//   • assetPrefix /v2: the export lands in dist/v2/ (+ dist/v2.html), so v1's
//     /assets/ and v2's /v2/_next/ never collide and the same HTML works at /.
//   • externalDir: the code lives in ../app/v2 and shares ../app/src/lib with v1.
//   • webpack (not Turbopack) for the two things v1's Vite build relies on:
//     the build id constant and `?url` asset imports (lib/exportDoc.js).
const BUILD = process.env.MC_BUILD || 'dev';

export default {
  output: 'export',
  assetPrefix: '/v2',
  trailingSlash: false,
  reactStrictMode: false, // the store has module-level side effects (watch leases)
  images: { unoptimized: true },
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  experimental: { externalDir: true },
  webpack(config, { webpack }) {
    config.plugins.push(new webpack.DefinePlugin({ __MC_BUILD__: JSON.stringify(BUILD) }));
    config.module.rules.unshift({ resourceQuery: /url/, type: 'asset/resource', generator: { filename: 'static/media/[name].[hash][ext]' } });
    return config;
  },
};
