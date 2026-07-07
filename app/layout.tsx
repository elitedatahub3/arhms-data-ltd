import type { Metadata, Viewport } from 'next'

export const viewport: Viewport = {
    width: 'device-width',
    initialScale: 1,
    themeColor: '#0A0A0A',
    // interactiveWidget removed: only supported in Chrome 108+, causes viewport
    // layout issues on older Android WebView (common on low-end phones in Ghana)
}
import { Outfit, Inter } from 'next/font/google'
import { Suspense } from 'react'
import './globals.css'
import { AuthProvider } from '@/contexts/auth-context'
import { Toaster } from '@/components/ui/sonner'
import { ThemeProvider } from '@/components/theme-provider'
import { GlobalLoader } from '@/components/ui/global-loader'
import PwaInstallPrompt from '@/components/pwa-install-prompt'
import { UIProvider } from '@/contexts/ui-context'
import { SystemAnnouncementModal } from '@/components/system-announcement-modal'
import { getActiveAnnouncement } from '@/lib/get-active-announcement'
import { SpeedInsights } from '@vercel/speed-insights/next'

const outfit = Outfit({
    weight: ['400', '600', '700'],
    subsets: ['latin'],
    display: 'optional', // 'optional' prevents FOFT double-render on slow CPUs
    variable: '--font-heading',
})

const inter = Inter({
    weight: ['400', '500', '600'],
    subsets: ['latin'],
    display: 'optional', // 'optional' prevents FOFT double-render on slow CPUs
    variable: '--font-body',
})

export const metadata: Metadata = {
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
    icons: {
        apple: '/apple-touch-icon.png',
        icon: [
            { url: '/icon-192x192.png', sizes: '192x192', type: 'image/png' },
            { url: '/icon-512x512.png', sizes: '512x512', type: 'image/png' },
        ],
    },
    openGraph: {
        title: 'ARHMS TECHNOLOGIES',
        description: "Ghana's trusted data bundle reselling platform",
        type: 'website',
        images: ['/opengraph-image.png'],
    },
}

export default async function RootLayout({
    children,
}: {
    children: React.ReactNode
}) {
    // Fetch the latest active announcement directly from DB (no cache, service role = no RLS)
    const systemAnnouncement = await getActiveAnnouncement()

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
            <body className={inter.className}>
                <ThemeProvider
                    attribute="class"
                    defaultTheme="light"
                    enableSystem
                    disableTransitionOnChange
                >
                    <AuthProvider>
                        <UIProvider>
                            <Suspense fallback={null}>
                                <GlobalLoader />
                            </Suspense>
                            {children}
                            <SystemAnnouncementModal initialAnnouncement={systemAnnouncement as any} />
                            <PwaInstallPrompt />
                            <Toaster position="top-center" richColors expand />
                        </UIProvider>
                    </AuthProvider>
                </ThemeProvider>
                <SpeedInsights />
            </body>
        </html>
    )
}
