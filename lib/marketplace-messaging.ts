import { createClient } from '@supabase/supabase-js'

/**
 * Server-side helpers shared by the marketplace conversation API routes.
 *
 * - listingImageUrl(): turns a classified_listing_images.storage_path into its
 *   public URL (same construction as components/classifieds/listing-card.tsx).
 * - getUserDisplayNames(): resolves participant ids → display names. A
 *   conversation's "other user" may be a BUYER, who is not exposed by the
 *   public seller view, so this uses the service-role client to read
 *   users.first_name/last_name (bypassing RLS). Names shown to the other
 *   participant of a private chat — expected, same as public seller names.
 */

const STORAGE_BUCKET = 'classified-listing-images'

export function listingImageUrl(storagePath?: string | null): string | null {
    if (!storagePath) return null
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
    return `${base}/storage/v1/object/public/${STORAGE_BUCKET}/${storagePath}`
}

/** Primary image (lowest display_order) from an embedded images array → URL. */
export function primaryImageUrl(
    images?: Array<{ storage_path: string; display_order: number }> | null
): string | null {
    if (!images || images.length === 0) return null
    const primary = [...images].sort((a, b) => a.display_order - b.display_order)[0]
    return listingImageUrl(primary?.storage_path)
}

function serviceClient() {
    return createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
}

/** Map of userId → display name for the given ids (missing ids omitted). */
export async function getUserDisplayNames(
    userIds: string[]
): Promise<Record<string, string>> {
    const ids = [...new Set(userIds.filter(Boolean))]
    if (ids.length === 0) return {}

    try {
        const { data, error } = await serviceClient()
            .from('users')
            .select('id, first_name, last_name')
            .in('id', ids)

        if (error || !data) return {}

        const out: Record<string, string> = {}
        for (const u of data as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
            const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
            out[u.id] = name || 'Marketplace user'
        }
        return out
    } catch {
        return {}
    }
}
