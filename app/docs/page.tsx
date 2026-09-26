import DocsClient from '@/components/docs/docs-client'

// The catalogue carries lucide icon components, which cannot cross the server/client
// boundary as props — so the client component imports it directly rather than
// receiving it from here.
export default function DocsPage() {
    return <DocsClient />
}
