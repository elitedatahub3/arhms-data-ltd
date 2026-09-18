import type { Metadata, Viewport } from 'next'

export const viewport: Viewport = {
    width: 'device-width',
    initialScale: 1,
    // Browser chrome (iOS Safari status bar + toolbar, Android address bar) follows
    // the phone's system theme: white in light mode, dark in dark mode.
    themeColor: [
        { media: '(prefers-color-scheme: light)', color: '#ffffff' },
        { media: '(prefers-color-scheme: dark)', color: '#000000' },
    ],
    // interactiveWidget removed: only supported in Chrome 108+, causes viewport
    // layout issues on older Android WebView (common on low-end phones in Ghana)
}
import { Outfit, Inter } from 'next/font/google'
import { Suspense } from 'react'
import './globals.css'
import { AuthProvider } from '@/contexts/auth-context'
import { Toaster } from '@/components/ui/sonner'
import { ThemeProvider } from '@/components/theme-provider'
import { NavProgress } from '@/components/ui/nav-progress'
import PwaInstallPrompt from '@/components/pwa-install-prompt'
import { UIProvider } from '@/contexts/ui-context'
import { SWRProvider } from '@/components/swr-provider'
import { SystemAnnouncementModal } from '@/components/system-announcement-modal'
import { OfflineModal } from '@/components/offline-modal'

// Both families are variable fonts, so omitting `weight` ships one file carrying
// the whole axis instead of a separate file per static weight. That is what makes
// font-medium/-bold/-black real rather than browser-synthesised: the previous
// static list stopped at 700, so every `font-black` (900) was faux-emboldened.
const outfit = Outfit({
    subsets: ['latin'],
    display: 'optional', // 'optional' prevents FOFT double-render on slow CPUs
    variable: '--font-heading',
})

const inter = Inter({
    subsets: ['latin'],
    display: 'optional', // 'optional' prevents FOFT double-render on slow CPUs
    variable: '--font-body',
})

export const metadata: Metadata = {
    // Without this, Next resolves relative OG/Twitter image paths against whatever host
    // it can infer — the production build happens to guess arhmsgh.com, a local build
    // guesses localhost. Pinning it makes every share preview point at the real site.
    metadataBase: new URL('https://arhmsgh.com'),
    title: 'ARHMS TECHNOLOGIES',
    description: "Ghana's trusted data bundle reselling platform. Buy and resell MTN, Telecel and AirtelTigo bundles instantly.",
    keywords: ['Ghana', 'mobile data', 'airtime', 'MTN', 'Telecel', 'AirtelTigo', 'data bundles', 'reseller'],
    authors: [{ name: 'ARHMS TECHNOLOGIES' }],
    manifest: '/manifest.json',
    appleWebApp: {
        capable: true,
        statusBarStyle: 'black-translucent',
        title: 'ARHMS',
    },
    // The 512x512 is deliberately not listed here. Entries in `icons.icon` become
    // <link rel="icon"> tags, which browsers treat as favicon candidates and may
    // fetch on a cold page load — 225 KB for something rendered at 16-32px. It is
    // still declared in manifest.json, which is where an installable PWA actually
    // needs it, and which is only read at install time.
    icons: {
        apple: '/apple-touch-icon.png',
        icon: [
            { url: '/icon-192x192.png', sizes: '192x192', type: 'image/png' },
        ],
    },
    openGraph: {
        title: 'ARHMS TECHNOLOGIES',
        description: "Ghana's trusted data bundle reselling platform",
        type: 'website',
        images: [{ url: '/arhms-logo.png', width: 512, height: 512, alt: 'ARHMS TECHNOLOGIES' }],
    },
}

export default function RootLayout({
    children,
}: {
    children: React.ReactNode
}) {
    return (
        <html lang="en" suppressHydrationWarning className={`${outfit.variable} ${inter.variable}`}>
            <head>
                {/* Auto-reload once if a Next.js JS/CSS chunk fails to load on slow connections */}
                <script
                    dangerouslySetInnerHTML={{
                        __html: `(function(){var h=false;window.addEventListener('error',function(e){if(!h&&e&&e.target&&(e.target.tagName==='SCRIPT'||e.target.tagName==='LINK')){var s=e.target.src||e.target.href||'';if(s.indexOf('/_next/')!==-1){h=true;setTimeout(function(){window.location.reload();},1500);}}},true);})();`,
                    }}
                />
            </head>
            <body className="font-body bg-bubbles">
                <ThemeProvider
                    attribute="class"
                    defaultTheme="system"
                    enableSystem
                    disableTransitionOnChange
                >
                    <AuthProvider>
                        <SWRProvider>
                        <UIProvider>
                            <Suspense fallback={null}>
                                <NavProgress />
                            </Suspense>
                            {children}
                            <SystemAnnouncementModal />
                            <PwaInstallPrompt />
                            <OfflineModal />
                            {/* richColors dropped: components/ui/sonner.tsx now
                                colours each kind of message itself. */}
                            <Toaster position="top-center" expand />
                        </UIProvider>
                        </SWRProvider>
                    </AuthProvider>
                </ThemeProvider>
            </body>
        </html>
    )
}
