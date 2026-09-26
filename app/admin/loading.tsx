// Instant loading boundary for every /admin/* route. Renders inside the admin
// layout, so its chrome stays and only the content area shows a skeleton the
// moment a link is tapped. See app/dashboard/loading.tsx.
export default function AdminLoading() {
    return (
        <div className="space-y-5" aria-busy="true">
            <div className="h-8 w-56 rounded-lg bg-muted animate-pulse" />
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div className="h-24 rounded-2xl bg-muted animate-pulse" />
                <div className="h-24 rounded-2xl bg-muted animate-pulse" />
                <div className="h-24 rounded-2xl bg-muted animate-pulse" />
                <div className="h-24 rounded-2xl bg-muted animate-pulse" />
            </div>
            <div className="h-80 w-full rounded-2xl bg-muted animate-pulse" />
            <span className="sr-only" role="status">Loading…</span>
        </div>
    )
}
