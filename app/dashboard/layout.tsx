import DashboardShell from './dashboard-shell'

// Every dashboard route renders per request. It is built entirely around the
// signed-in user — profile, wallet, role gates — so a build-time render would
// bake in the signed-out skeleton for everyone.
//
// This wrapper exists because route segment config cannot be exported from a
// `'use client'` module, and the shell below is one. The root layout used to
// force the whole app dynamic with a bare noStore(); now that it does not, each
// subtree that genuinely cannot be static declares it here.
//
// Keeping the server/client boundary at this file is also what later lets the
// profile be read server-side and passed down as props, instead of the shell
// fetching it after hydration.
export const dynamic = 'force-dynamic'

export default function DashboardLayout({
    children,
}: {
    children: React.ReactNode
}) {
    return <DashboardShell>{children}</DashboardShell>
}
