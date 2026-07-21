import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Vantage',
  description: 'Personal equity research and portfolio optimization tool',
  applicationName: 'Vantage',
  formatDetection: {
    telephone: false,
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Vantage',
  },
  icons: {
    icon: '/icon-512.png',
    apple: '/icon-512.png',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'dark',
  themeColor: '#0a0a0b',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Dark mode is the default — the `dark` class on <html> means
  // all @custom-variant dark styles apply out of the box.
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="min-h-dvh overflow-x-hidden antialiased">{children}</body>
    </html>
  );
}
