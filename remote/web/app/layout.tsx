import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Mission Control',
  description: 'Mia and her agents, live.',
  manifest: '/v6/manifest.json',
  appleWebApp: { capable: true, title: 'Mission Control', statusBarStyle: 'black-translucent' },
  icons: { apple: '/apple-touch-icon.png', icon: '/icon.svg' },
};
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0c0b0e',
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
