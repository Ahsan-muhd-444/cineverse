import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ToastProvider } from '@/components/ui/Bits';
import { BootScreen } from '@/components/layout/BootScreen';
import { SettingsBoot } from '@/components/layout/SettingsBoot';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'),
  title: {
    default: 'CineVerse — a private cinema for two',
    template: '%s · CineVerse',
  },
  description:
    'Watch anything together, perfectly in sync, with live chat and calls. A private cinema you can open in one click — no accounts, no downloads.',
  applicationName: 'CineVerse',
  keywords: ['watch together', 'watch party', 'sync video', 'private cinema', 'long distance'],
  openGraph: {
    title: 'CineVerse — a private cinema for two',
    description: 'Perfectly synced playback, live chat, and calls. Open a room, share the link, press play together.',
    type: 'website',
  },
  twitter: { card: 'summary_large_image', title: 'CineVerse', description: 'A private cinema for two.' },
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
    apple: '/icon.svg',
  },
};

export const viewport: Viewport = {
  themeColor: '#090909',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" data-contrast="normal" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Loaded as a stylesheet rather than next/font so the production build
            never depends on network access at compile time. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Sora:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <style
          // Font variables, declared inline so they apply before hydration.
          dangerouslySetInnerHTML={{
            __html: `:root{--font-sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--font-display:"Sora","Inter",ui-sans-serif,sans-serif;--font-mono:"JetBrains Mono",ui-monospace,monospace}`,
          }}
        />
      </head>
      <body className="min-h-dvh bg-ink-900 font-sans">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[300] focus:rounded-xl focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-black"
        >
          Skip to content
        </a>
        <SettingsBoot />
        <BootScreen />
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
