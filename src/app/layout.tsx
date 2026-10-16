import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Daftari',
    template: '%s | Daftari',
  },
  description:
    'Voice-first bookkeeper for Tanzanian small businesses. Send a WhatsApp voice note, review what Daftari understood, then confirm.',
  applicationName: 'Daftari',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0B0B0F',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}