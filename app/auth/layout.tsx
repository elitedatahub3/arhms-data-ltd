// Auth routes render per request. They branch on the current session and read
// query parameters (?redirect, ?code, ?error) on nearly every page, so a build-time
// render would bake in the signed-out branch and a stale redirect target.
//
// This exists only to carry that declaration: the root layout used to force the
// whole app dynamic with a bare noStore(), and now that it does not, the subtrees
// that genuinely cannot be static say so themselves. It adds no markup.
export const dynamic = 'force-dynamic'

export default function AuthLayout({
    children,
}: {
    children: React.ReactNode
}) {
    return <>{children}</>
}
