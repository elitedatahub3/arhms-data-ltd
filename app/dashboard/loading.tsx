// Instant loading boundary for every /dashboard/* route.
//
// Without it a tap on the bottom nav or a dashboard link leaves the old page on
// screen, with no feedback, until middleware and the new route's payload have
// both come back — on mobile data that reads as "the button didn't work". This
// renders inside the dashboard layout, so the header and bottom nav stay put and
// only the content area swaps to a skeleton on the same frame as the tap.
//
// Same rules as app/auth/loading.tsx: no context, no icons, no client code.
export default function DashboardLoading() {
    return (
        <div className="space-y-5" aria-busy="true">
            <div className="h-8 w-48 rounded-lg bg-muted animate-pulse" />
            <div className="h-28 w-full rounded-2xl bg-muted animate-pulse" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="h-20 rounded-2xl bg-muted animate-pulse" />
                <div className="h-20 rounded-2xl bg-muted animate-pulse" />
                <div className="h-20 rounded-2xl bg-muted animate-pulse" />
                <div className="h-20 rounded-2xl bg-muted animate-pulse" />
            </div>
            <div className="h-64 w-full rounded-2xl bg-muted animate-pulse" />
            <span className="sr-only" role="status">Loading…</span>
        </div>
    )
}
