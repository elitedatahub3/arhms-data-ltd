import type { Metadata } from 'next'

// Public on purpose: middleware.ts gates /dashboard, /admin and /api,
// and /docs is none of those. A developer should be able to read the whole contract
// before deciding to sign up — the key itself is still issued behind the login.
export const metadata: Metadata = {
    title: 'Developer API — ARHMSGH',
    description: 'Sell data bundles, airtime, result checkers, AFA registrations and utility bills from your own app with the ARHMSGH REST API.',
    alternates: { canonical: 'https://arhmsgh.com/docs' },
    openGraph: {
        title: 'ARHMSGH Developer API',
        description: 'Data, airtime, result checkers, AFA and utility bills over a simple REST API. Ghana networks only.',
        url: 'https://arhmsgh.com/docs',
        type: 'website',
        images: ['https://arhmsgh.com/arhms-logo.png'],
    },
}

export default function DocsLayout({ children }: { children: React.ReactNode }) {
    return children
}
