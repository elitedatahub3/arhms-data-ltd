// Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    toDeepSeekMessages,
    toDeepSeekTools,
    parseToolArguments,
    mapFinishReason,
    createChunkAccumulator,
    readChatStream,
    deepSeekTurn,
    DeepSeekError,
} from '../ai-assistant/deepseek.ts'
import { runAgentLoop } from '../ai-assistant/engine.ts'

test('canonical history → DeepSeek chat messages', () => {
    const out = toDeepSeekMessages('SYS', [
        { role: 'user', content: 'balance?' },
        {
            role: 'assistant',
            content: [
                { type: 'text', text: 'Checking.' },
                { type: 'tool_use', id: 'c1', name: 'get_wallet_balance', input: {} },
                { type: 'tool_use', id: 'c2', name: 'find_order', input: { query: 'ABC' } },
            ],
        },
        {
            role: 'user',
            content: [
                { type: 'tool_result', tool_use_id: 'c1', content: '<data>\n{"balance_ghs":5}\n</data>' },
                { type: 'tool_result', tool_use_id: 'c2', content: '<data>\n{}\n</data>', is_error: true },
            ],
        },
    ])
    assert.deepEqual(out[0], { role: 'system', content: 'SYS' })
    assert.deepEqual(out[1], { role: 'user', content: 'balance?' })
    assert.deepEqual(out[2], {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'get_wallet_balance', arguments: '{}' } },
            { id: 'c2', type: 'function', function: { name: 'find_order', arguments: '{"query":"ABC"}' } },
        ],
    })
    assert.deepEqual(out[3], { role: 'tool', tool_call_id: 'c1', content: '<data>\n{"balance_ghs":5}\n</data>' })
    assert.equal(out[4].role, 'tool')
    assert.equal(out.length, 5)
})

test('assistant with only tool calls sends content null; reasoning goes back as reasoning_content', () => {
    const out = toDeepSeekMessages('S', [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: [{ type: 'reasoning', text: 'think' }, { type: 'tool_use', id: 'a', name: 't', input: {} }] },
    ])
    assert.equal((out[2] as any).content, null)
    assert.equal((out[2] as any).reasoning_content, 'think')
})

test('tools become function definitions', () => {
    const t = toDeepSeekTools([{ name: 'n', description: 'd', input_schema: { type: 'object' } }])
    assert.deepEqual(t, [{ type: 'function', function: { name: 'n', description: 'd', parameters: { type: 'object' } } }])
})

test('parseToolArguments never throws', () => {
    assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 })
    assert.deepEqual(parseToolArguments('{"a":'), {})
    assert.deepEqual(parseToolArguments('[1]'), {})
    assert.deepEqual(parseToolArguments(''), {})
})

test('finish reasons map onto the engine stop reasons', () => {
    assert.equal(mapFinishReason('tool_calls', true), 'tool_use')
    assert.equal(mapFinishReason('stop', false), 'end_turn')
    assert.equal(mapFinishReason('length', true), 'max_tokens')
    assert.equal(mapFinishReason('content_filter', false), 'refusal')
})

test('accumulator rebuilds fragmented tool calls, text and usage', () => {
    const deltas: string[] = []
    const acc = createChunkAccumulator(d => deltas.push(d))
    acc.push({ choices: [{ delta: { content: 'Let me ' } }] })
    acc.push({ choices: [{ delta: { content: 'check.' } }] })
    acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'find_order', arguments: '{"qu' } }] } }] })
    acc.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ery":"X1"}' } }] } }] })
    acc.push({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'get_wallet_balance', arguments: '{}' } }] } }] })
    acc.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
    acc.push({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })
    const r = acc.result()
    assert.deepEqual(deltas, ['Let me ', 'check.'])
    assert.equal(r.stop_reason, 'tool_use')
    assert.deepEqual(r.usage, { input_tokens: 100, output_tokens: 20 })
    assert.deepEqual(r.content, [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'call_a', name: 'find_order', input: { query: 'X1' } },
        { type: 'tool_use', id: 'call_b', name: 'get_wallet_balance', input: {} },
    ])
})

function sseBody(lines: string[], splitAt = 7): ReadableStream<Uint8Array> {
    const text = lines.join('\n') + '\n'
    const enc = new TextEncoder()
    // Deliberately split mid-line to exercise buffering.
    const parts: string[] = []
    for (let i = 0; i < text.length; i += splitAt) parts.push(text.slice(i, i + splitAt))
    return new ReadableStream({
        start(c) {
            for (const p of parts) c.enqueue(enc.encode(p))
            c.close()
        },
    })
}

test('readChatStream parses SSE split across reads and stops at [DONE]', async () => {
    const got: any[] = []
    await readChatStream(
        sseBody([': keep-alive', '', 'data: {"n":1}', '', 'data: {"n":2}', 'data: [DONE]', 'data: {"n":3}']),
        c => got.push(c.n),
    )
    assert.deepEqual(got, [1, 2])
})

const chunk = (o: unknown) => `data: ${JSON.stringify(o)}`

test('engine + DeepSeek adapter: tool round then answer, against a fake server', async () => {
    const requests: any[] = []
    const replies = [
        [
            chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_wallet_balance', arguments: '{}' } }] } }] }),
            chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
            'data: [DONE]',
        ],
        [
            chunk({ choices: [{ delta: { content: 'You have GHS 5.00.' } }] }),
            chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
            'data: [DONE]',
        ],
    ]
    const fakeFetch = (async (_url: string, init: any) => {
        requests.push(JSON.parse(init.body))
        return new Response(sseBody(replies[requests.length - 1]), { status: 200 })
    }) as unknown as typeof fetch

    const createTurn = deepSeekTurn({
        apiKey: 'k', model: 'deepseek-chat', system: 'SYS', maxTokens: 500,
        tools: [{ name: 'get_wallet_balance', description: 'd', input_schema: { type: 'object', properties: {} } }],
        fetchImpl: fakeFetch,
    })
    const r = await runAgentLoop({
        createTurn,
        runTool: async () => ({ content: '{"balance_ghs":5}' }),
        messages: [{ role: 'user', content: 'balance?' }],
        maxRounds: 5,
    })
    assert.equal(r.text, 'You have GHS 5.00.')
    assert.equal(requests.length, 2)
    assert.equal(requests[0].model, 'deepseek-chat')
    assert.equal(requests[0].stream, true)
    const second = requests[1].messages
    assert.equal(second.at(-1).role, 'tool')
    assert.equal(second.at(-1).tool_call_id, 'c1')
    assert.equal(second.at(-1).content, '<data>\n{"balance_ghs":5}\n</data>')
})

test('HTTP errors surface as DeepSeekError with the status', async () => {
    const fakeFetch = (async () => new Response('{"error":{"message":"Insufficient Balance"}}', { status: 402 })) as unknown as typeof fetch
    const createTurn = deepSeekTurn({ apiKey: 'k', model: 'deepseek-chat', system: 'S', tools: [], maxTokens: 10, fetchImpl: fakeFetch })
    await assert.rejects(
        createTurn({ messages: [{ role: 'user', content: 'x' }], onText: () => {} }),
        (e: any) => e instanceof DeepSeekError && e.status === 402,
    )
})
