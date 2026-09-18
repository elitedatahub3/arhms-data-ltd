import AdminShell from './admin-shell'

// Admin routes render per request: they are role-gated and read live operational
// data, so nothing here can be prerendered at build time.
//
// This wrapper exists because route segment config cannot be exported from a
// `'use client'` module, and the shell below is one. See app/dashboard/layout.tsx
// for the same pattern and the reasoning behind it.
export const dynamic = 'force-dynamic'

export default function AdminLayout({
    children,
}: {
    children: React.ReactNode
}) {
    return <AdminShell>{children}</AdminShell>
}
