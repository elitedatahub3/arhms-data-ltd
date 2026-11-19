/**
 * Search the admin-editable knowledge base (ai_knowledge) for one assistant
 * surface. Shared by the dashboard tools and the storefront assistant.
 */
import { knowledgeSearchTerms, rankKnowledge, type AssistantSurface, type KnowledgeRow } from './helpers'

export type KnowledgeSearchResult =
    | { ok: true; results: { question: string; answer: string }[] }
    | { ok: false; error: string }

export async function searchKnowledge(db: any, query: string, surface: AssistantSurface): Promise<KnowledgeSearchResult> {
    const terms = knowledgeSearchTerms(query)
    if (!terms.length) return { ok: true, results: [] }
    // Terms are [a-z0-9] only (knowledgeSearchTerms), so they are safe inside or().
    const or = terms.flatMap(t => [`question.ilike.%${t}%`, `answer.ilike.%${t}%`, `category.ilike.%${t}%`]).join(',')
    const { data, error } = await db.from('ai_knowledge').select('id, category, question, answer')
        .eq('is_active', true).contains('contexts', [surface]).or(or).limit(50)
    if (error) {
        // Loud on purpose: a missing table would otherwise fail silently forever.
        console.error('[ARHMS AI] knowledge search failed, is migration 20261118010000 run?', error.message)
        return { ok: false, error: 'Knowledge base unavailable.' }
    }
    return {
        ok: true,
        results: rankKnowledge((data || []) as KnowledgeRow[], terms).map(r => ({ question: r.question, answer: r.answer.slice(0, 2000) })),
    }
}
