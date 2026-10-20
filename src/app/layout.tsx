import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Daftari',
    template: '%s | Daftari',
  },
  description:
    'Voice-first bookkeeping for Tanzanian small businesses. Record, review, and confirm business activity.',
  applicationName: 'Daftari',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0D1B2A',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}