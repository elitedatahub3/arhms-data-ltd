/**
 * Search over the site index: the text users see on every customer-facing page,
 * generated on each build by scripts/build-site-index.mjs.
 */
import index from './site-index.json'
import { knowledgeSearchTerms, rankSiteChunks, type SiteChunk } from './helpers'

const CHUNKS = ((index as any)?.chunks || []) as SiteChunk[]

export function siteIndexSize(): number {
    return CHUNKS.length
}

export function searchSite(query: string, surface: SiteChunk['surface'], limit = 4) {
    const terms = knowledgeSearchTerms(query)
    return rankSiteChunks(CHUNKS, terms, surface, limit).map(c => ({
        page: c.path,
        menu: c.menu || undefined,
        section: c.heading || undefined,
        text: c.text.slice(0, 700),
    }))
}
