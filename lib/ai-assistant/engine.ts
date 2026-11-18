/**
 * ARHMS AI agent loop, shared by every surface (dashboard today; storefront,
 * public site, admin console and WhatsApp next).
 *
 * No runtime imports on purpose: the model call (createTurn) and the tool runner
 * (runTool) are passed in, so node --test can drive the loop with a fake model.
 * Covered by lib/__tests__/ai-assistant-engine.test.mts.
 *
 * Rules it enforces:
 *   - a round cap per surface (a runaway loop costs money and time);
 *   - every tool of a round runs concurrently and ALL results go back in ONE
 *     user message (splitting them teaches the model to stop calling in parallel);
 *   - tool output is fenced in <data>…</data> and truncated; the system prompt
 *     says anything inside <data> is data, never instructions;
 *   - a tool that throws becomes an is_error result, never a crash.
 */

/** Tool definition shown to the model (provider adapters translate it). */
export interface ToolDef {
    name: string
    description: string
    input_schema: Record<string, unknown>
}

export type TextBlock = { type: 'text'; text: string }
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
export type ContentBlock = TextBlock | ToolUseBlock | { type: string; [k: string]: unknown }

export interface EngineMessage {
    role: 'user' | 'assistant'
    content: string | ContentBlock[] | ToolResultBlock[]
}

export interface TurnResult {
    content: ContentBlock[]
    stop_reason: string | null
    usage?: { input_tokens?: number; output_tokens?: number }
}

/** One model call. Streams text deltas through onText and resolves with the final message. */
export type CreateTurn = (p: { messages: EngineMessage[]; onText: (delta: string) => void }) => Promise<TurnResult>

export interface ToolRun<Extra = unknown> {
    content: string
    isError?: boolean
    /** UI side effects (bundle cards, checkout prefill…), handed to onToolOutput. */
    extra?: Extra
}

export type RunTool<Extra = unknown> = (name: string, input: unknown) => Promise<ToolRun<Extra>>

export const TOOL_RESULT_MAX_CHARS = 6000

/** Fence tool output so the model treats it as data, and cap its size. */
export function fenceToolResult(content: string, max: number = TOOL_RESULT_MAX_CHARS): string {
    const body = content.length > max ? content.slice(0, max) + '…[truncated]' : content
    return `<data>\n${body}\n</data>`
}

export interface AgentLoopResult {
    text: string
    toolsUsed: string[]
    rounds: number
    inputTokens: number
    outputTokens: number
    refused: boolean
    hitRoundCap: boolean
}

export async function runAgentLoop<Extra = unknown>(opts: {
    createTurn: CreateTurn
    runTool: RunTool<Extra>
    messages: EngineMessage[]
    maxRounds: number
    onText?: (delta: string) => void
    onToolOutput?: (name: string, out: ToolRun<Extra>) => void
}): Promise<AgentLoopResult> {
    const history: EngineMessage[] = [...opts.messages]
    const toolsUsed: string[] = []
    let text = ''
    let inputTokens = 0
    let outputTokens = 0
    let refused = false
    let rounds = 0
    let hitRoundCap = true

    const say = (delta: string) => {
        text += delta
        opts.onText?.(delta)
    }

    for (let round = 0; round < opts.maxRounds; round++) {
        rounds = round + 1
        // A tool round that already said something gets a break before the next text.
        if (round > 0 && text && !text.endsWith('\n')) say('\n\n')

        const turn = await opts.createTurn({ messages: history, onText: say })
        inputTokens += turn.usage?.input_tokens || 0
        outputTokens += turn.usage?.output_tokens || 0

        if (turn.stop_reason === 'refusal') {
            refused = true
            hitRoundCap = false
            break
        }

        const toolUses = turn.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
        if (turn.stop_reason !== 'tool_use' || toolUses.length === 0) {
            hitRoundCap = false
            break
        }

        history.push({ role: 'assistant', content: turn.content })

        const results = await Promise.all(
            toolUses.map(async (t): Promise<ToolResultBlock> => {
                toolsUsed.push(t.name)
                let out: ToolRun<Extra>
                try {
                    out = await opts.runTool(t.name, t.input)
                } catch {
                    out = { content: 'This lookup failed. Tell the user to try again in a moment.', isError: true }
                }
                opts.onToolOutput?.(t.name, out)
                return {
                    type: 'tool_result',
                    tool_use_id: t.id,
                    content: fenceToolResult(out.content),
                    ...(out.isError ? { is_error: true } : {}),
                }
            }),
        )
        history.push({ role: 'user', content: results })
    }

    return { text, toolsUsed, rounds, inputTokens, outputTokens, refused, hitRoundCap }
}
