import type { Metadata } from 'next'

// Public on purpose: middleware.ts gates /dashboard, /admin and /api,
// and /docs is none of those. A developer should be able to read the whole contract
// before deciding to sign up — the key itself is still issued behind the login.
const docBaseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.dataking.qzz.io'

export const metadata: Metadata = {
    title: 'Developer API — ARHMSGH',
    description: 'Sell data bundles, airtime, result checkers, AFA registrations and utility bills from your own app with the ARHMSGH REST API.',
    alternates: { canonical: `${docBaseUrl}/docs` },
    openGraph: {
        title: 'ARHMSGH Developer API',
        description: 'Data, airtime, result checkers, AFA and utility bills over a simple REST API. Ghana networks only.',
        url: `${docBaseUrl}/docs`,
        type: 'website',
        images: [`${docBaseUrl}/arhms-logo.png`],
    },
}

export default function DocsLayout({ children }: { children: React.ReactNode }) {
    return children
}
