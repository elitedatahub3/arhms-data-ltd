// Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAgentLoop, fenceToolResult, type CreateTurn, type TurnResult } from '../ai-assistant/engine.ts'

/** Fake model that plays back a script of turns and records what it was sent. */
function scripted(turns: TurnResult[]) {
    const seen: any[][] = []
    let i = 0
    const createTurn: CreateTurn = async ({ messages, onText }) => {
        seen.push(JSON.parse(JSON.stringify(messages)))
        const t = turns[Math.min(i++, turns.length - 1)]
        for (const b of t.content) if (b.type === 'text') onText((b as any).text)
        return t
    }
    return { createTurn, seen }
}

const toolTurn = (...calls: { id: string; name: string; input?: unknown }[]): TurnResult => ({
    content: calls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} })),
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 2 },
})
const answer = (text: string): TurnResult => ({
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 3 },
})

test('tool call then answer: runs the tool and returns the final text', async () => {
    const { createTurn, seen } = scripted([toolTurn({ id: 't1', name: 'get_wallet_balance' }), answer('You have GHS 12.00.')])
    const r = await runAgentLoop({
        createTurn,
        runTool: async () => ({ content: '{"balance_ghs":12}' }),
        messages: [{ role: 'user', content: 'balance?' }],
        maxRounds: 5,
    })
    assert.equal(r.text, 'You have GHS 12.00.')
    assert.deepEqual(r.toolsUsed, ['get_wallet_balance'])
    assert.equal(r.rounds, 2)
    assert.equal(r.inputTokens, 15)
    assert.equal(r.outputTokens, 5)
    assert.equal(r.hitRoundCap, false)
    // Second call saw: user, assistant(tool_use), user(tool_result)
    assert.equal(seen[1].length, 3)
    assert.equal(seen[1][2].content[0].type, 'tool_result')
})

test('parallel tool calls come back in ONE user message, fenced in <data>', async () => {
    const { createTurn, seen } = scripted([
        toolTurn({ id: 'a', name: 'x' }, { id: 'b', name: 'y' }),
        answer('done'),
    ])
    await runAgentLoop({
        createTurn,
        runTool: async name => ({ content: `out-${name}` }),
        messages: [{ role: 'user', content: 'hi' }],
        maxRounds: 5,
    })
    const results = seen[1][2].content
    assert.equal(results.length, 2)
    assert.deepEqual(results.map((r: any) => r.tool_use_id), ['a', 'b'])
    assert.equal(results[0].content, '<data>\nout-x\n</data>')
})

test('a throwing tool becomes an is_error result instead of crashing', async () => {
    const { createTurn, seen } = scripted([toolTurn({ id: 'a', name: 'boom' }), answer('Sorry, that failed.')])
    const r = await runAgentLoop({
        createTurn,
        runTool: async () => { throw new Error('db down') },
        messages: [{ role: 'user', content: 'hi' }],
        maxRounds: 5,
    })
    assert.equal(r.text, 'Sorry, that failed.')
    const res = seen[1][2].content[0]
    assert.equal(res.is_error, true)
    assert.ok(!res.content.includes('db down'), 'raw error must not reach the model')
})

test('stops at the round cap when the model keeps calling tools', async () => {
    const { createTurn, seen } = scripted([toolTurn({ id: 'a', name: 'loop' })])
    const r = await runAgentLoop({
        createTurn,
        runTool: async () => ({ content: 'again' }),
        messages: [{ role: 'user', content: 'hi' }],
        maxRounds: 3,
    })
    assert.equal(seen.length, 3)
    assert.equal(r.rounds, 3)
    assert.equal(r.hitRoundCap, true)
})

test('refusal stops the loop and is reported', async () => {
    const { createTurn } = scripted([{ content: [], stop_reason: 'refusal' }])
    const r = await runAgentLoop({
        createTurn,
        runTool: async () => ({ content: '' }),
        messages: [{ role: 'user', content: 'x' }],
        maxRounds: 5,
    })
    assert.equal(r.refused, true)
    assert.equal(r.text, '')
})

test('text from a tool round and the answer are separated by a blank line', async () => {
    const t1 = toolTurn({ id: 'a', name: 'x' })
    t1.content.unshift({ type: 'text', text: 'Let me check.' })
    const { createTurn } = scripted([t1, answer('Found it.')])
    const r = await runAgentLoop({
        createTurn,
        runTool: async () => ({ content: '{}' }),
        messages: [{ role: 'user', content: 'x' }],
        maxRounds: 5,
    })
    assert.equal(r.text, 'Let me check.\n\nFound it.')
})

test('onToolOutput receives UI extras', async () => {
    const { createTurn } = scripted([toolTurn({ id: 'a', name: 'show_bundle_cards' }), answer('Tap one.')])
    const got: any[] = []
    await runAgentLoop({
        createTurn,
        runTool: async () => ({ content: '{"shown":1}', extra: [{ packageId: 'p1' }] }),
        onToolOutput: (name, out) => got.push([name, out.extra]),
        messages: [{ role: 'user', content: 'x' }],
        maxRounds: 5,
    })
    assert.deepEqual(got, [['show_bundle_cards', [{ packageId: 'p1' }]]])
})

test('fenceToolResult truncates long output', () => {
    const out = fenceToolResult('a'.repeat(50), 10)
    assert.equal(out, `<data>\n${'a'.repeat(10)}…[truncated]\n</data>`)
})
