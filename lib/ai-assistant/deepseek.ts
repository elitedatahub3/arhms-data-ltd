/**
 * DeepSeek adapter for the ARHMS AI engine (OpenAI-compatible chat completions).
 *
 * Translates the engine's canonical messages (Anthropic-style content blocks)
 * to DeepSeek's chat format and back, and streams text deltas as they arrive.
 * Plain fetch, no SDK, no runtime imports, so node --test can cover the
 * converters and the stream parser (lib/__tests__/ai-assistant-deepseek.test.mts).
 *
 *   canonical                       → DeepSeek
 *   system string                   → first { role: 'system' } message
 *   assistant text + tool_use       → { role: 'assistant', content, tool_calls[] } (arguments = JSON string)
 *   user tool_result blocks         → one { role: 'tool', tool_call_id, content } per result
 *   reasoning block (reasoner only) → reasoning_content on that assistant message
 */
import type { CreateTurn, EngineMessage, ToolDef, TurnResult } from './engine'

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

export class DeepSeekError extends Error {
    status: number
    constructor(status: number, message: string) {
        super(message)
        this.status = status
        this.name = 'DeepSeekError'
    }
}

type ChatMessage =
    | { role: 'system' | 'user'; content: string }
    | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[]; reasoning_content?: string }
    | { role: 'tool'; tool_call_id: string; content: string }

interface ChatToolCall {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
}

export function toDeepSeekTools(tools: ToolDef[]) {
    return tools.map(t => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.input_schema },
    }))
}

export function toDeepSeekMessages(system: string, messages: EngineMessage[]): ChatMessage[] {
    const out: ChatMessage[] = [{ role: 'system', content: system }]
    for (const m of messages) {
        if (typeof m.content === 'string') {
            out.push({ role: m.role, content: m.content } as ChatMessage)
            continue
        }
        const blocks = m.content as any[]
        if (m.role === 'user') {
            const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n')
            if (text) out.push({ role: 'user', content: text })
            for (const b of blocks) {
                if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content ?? '') })
            }
            continue
        }
        const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('')
        const reasoning = blocks.filter(b => b.type === 'reasoning').map(b => b.text).join('')
        const calls: ChatToolCall[] = blocks
            .filter(b => b.type === 'tool_use')
            .map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }))
        out.push({
            role: 'assistant',
            content: text || null,
            ...(calls.length ? { tool_calls: calls } : {}),
            ...(reasoning ? { reasoning_content: reasoning } : {}),
        })
    }
    return out
}

/** Model's argument string → object. Bad JSON becomes {} and fails tool validation as an is_error result. */
export function parseToolArguments(raw: string): Record<string, unknown> {
    try {
        const v = JSON.parse(raw || '{}')
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
    } catch {
        return {}
    }
}

export function mapFinishReason(reason: string | null | undefined, hasToolCalls: boolean): string {
    if (reason === 'tool_calls' || (hasToolCalls && reason !== 'length')) return 'tool_use'
    if (reason === 'length') return 'max_tokens'
    if (reason === 'content_filter') return 'refusal'
    return 'end_turn'
}

/**
 * Fold a stream of chat-completion chunks into one canonical turn.
 * Tool calls arrive in pieces keyed by index (id + name first, arguments in fragments).
 */
export function createChunkAccumulator(onText: (delta: string) => void) {
    let text = ''
    let reasoning = ''
    let finish: string | null = null
    let usage: { input_tokens: number; output_tokens: number } | undefined
    const calls = new Map<number, { id: string; name: string; args: string }>()

    return {
        push(chunk: any) {
            if (chunk?.usage) {
                usage = { input_tokens: chunk.usage.prompt_tokens || 0, output_tokens: chunk.usage.completion_tokens || 0 }
            }
            const choice = chunk?.choices?.[0]
            if (!choice) return
            const d = choice.delta || {}
            if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content
            if (typeof d.content === 'string' && d.content) {
                text += d.content
                onText(d.content)
            }
            for (const tc of d.tool_calls || []) {
                const i = typeof tc.index === 'number' ? tc.index : calls.size
                const cur = calls.get(i) || { id: '', name: '', args: '' }
                if (tc.id) cur.id = tc.id
                if (tc.function?.name) cur.name += tc.function.name
                if (tc.function?.arguments) cur.args += tc.function.arguments
                calls.set(i, cur)
            }
            if (choice.finish_reason) finish = choice.finish_reason
        },
        result(): TurnResult {
            const toolBlocks = [...calls.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([i, c]) => ({
                    type: 'tool_use',
                    id: c.id || `call_${i}`,
                    name: c.name,
                    input: parseToolArguments(c.args),
                }))
            const content: any[] = []
            if (reasoning) content.push({ type: 'reasoning', text: reasoning })
            if (text) content.push({ type: 'text', text })
            content.push(...toolBlocks)
            return { content, stop_reason: mapFinishReason(finish, toolBlocks.length > 0), usage }
        },
    }
}

/** Feed a server-sent-events body ("data: {...}" lines, ending "data: [DONE]") into the accumulator. */
export async function readChatStream(body: ReadableStream<Uint8Array>, onChunk: (chunk: any) => void) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line.startsWith('data:')) continue // blank lines and ": keep-alive" comments
            const data = line.slice(5).trim()
            if (data === '[DONE]') return
            try {
                onChunk(JSON.parse(data))
            } catch {
                /* ignore a malformed line */
            }
        }
    }
}

/** A CreateTurn for the engine, bound to one request's model, prompt and tools. */
export function deepSeekTurn(opts: {
    apiKey: string
    model: string
    system: string
    tools: ToolDef[]
    maxTokens: number
    signal?: AbortSignal
    baseUrl?: string
    fetchImpl?: typeof fetch
}): CreateTurn {
    const doFetch = opts.fetchImpl ?? fetch
    const tools = toDeepSeekTools(opts.tools)
    return async ({ messages, onText }) => {
        const res = await doFetch(`${opts.baseUrl ?? DEEPSEEK_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` },
            body: JSON.stringify({
                model: opts.model,
                messages: toDeepSeekMessages(opts.system, messages),
                ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
                max_tokens: opts.maxTokens,
                stream: true,
                stream_options: { include_usage: true },
            }),
            signal: opts.signal,
        })
        if (!res.ok || !res.body) {
            const detail = await res.text().catch(() => '')
            throw new DeepSeekError(res.status, detail.slice(0, 300) || res.statusText)
        }
        const acc = createChunkAccumulator(onText)
        await readChatStream(res.body, c => acc.push(c))
        return acc.result()
    }
}
