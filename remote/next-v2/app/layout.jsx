import '../../app/v2/v2.css';

// Panel v2 (task 0444) as a Next.js App Router static export. The relay
// (server.js) serves out/index.html as dist/v2.html to devices that chose v2,
// assets under /v2/_next/; the API, WebSocket and realtime stay the relay's.

export const metadata = {
  title: 'Mission Control',
  manifest: '/manifest.json',
  icons: { icon: '/icon.svg', apple: '/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'Mission Control', statusBarStyle: 'black-translucent' },
  other: { 'mobile-web-app-capable': 'yes' },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0b0b0d' },
    { media: '(prefers-color-scheme: light)', color: '#f4f3ef' },
  ],
};

// Runs before first paint: ?ui=v1|v2 picks this device's front end (kept in
// localStorage + the mc_ui cookie the relay reads), and the theme is set so
// nothing flashes.
const BOOT = `(function () {
  try {
    var p = new URLSearchParams(location.search), q = p.get('ui');
    if (/^(v1|v2|v3[abc])$/.test(q)) {
      localStorage.setItem('mc.ui', q);
      document.cookie = 'mc_ui=' + q + '; path=/; max-age=31536000; samesite=lax';
    }
    if ((q || localStorage.getItem('mc.ui')) === 'v1') return location.replace('/?ui=v1' + location.hash);
    if (q) { p.delete('ui'); history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p : '') + location.hash); }
    var t = localStorage.getItem('mc.v2.theme') || 'system';
    var dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch (e) {
    document.documentElement.dataset.theme = 'dark';
  }
})();`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="v2" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT }} />
      </head>
      <body>
        <div id="app">{children}</div>
      </body>
    </html>
  );
}
