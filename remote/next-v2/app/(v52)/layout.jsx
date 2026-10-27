import '../../../app/v52/v52.css';

// Panel v5.2 (task 0491, chat-first) has its own root layout so that only its own
// stylesheet (app/v52/v52.css, which builds on v5.css) is on the page — not v2's
// v2.css, and through it not v1's app.css.

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
    { media: '(prefers-color-scheme: dark)', color: '#08080a' },
    { media: '(prefers-color-scheme: light)', color: '#e9e7e2' },
  ],
};

// Before first paint: ?ui= picks this device's front end (localStorage + the
// mc_ui cookie the relay reads), and the theme is set so nothing flashes.
const BOOT = `(function () {
  try {
    var p = new URLSearchParams(location.search), q = p.get('ui');
    if (/^(v1|v2|v52?|v[34][abc])$/.test(q)) {
      localStorage.setItem('mc.ui', q);
      document.cookie = 'mc_ui=' + q + '; path=/; max-age=31536000; samesite=lax';
      if (q !== 'v52') return location.replace('/?ui=' + q + location.hash);
    }
    if (q) { p.delete('ui'); history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p : '') + location.hash); }
    var t = localStorage.getItem('mc.v2.theme') || 'system';
    var f = p.get('theme');
    if (f === 'light' || f === 'dark') t = f;
    var dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch (e) {
    document.documentElement.dataset.theme = 'dark';
  }
})();`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="v5 v52" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT }} />
      </head>
      <body>
        <div id="app">{children}</div>
      </body>
    </html>
  );
}
