// Run: npm test  (node --test with built-in TypeScript stripping; no deps)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    parseAssistantMode,
    parseDailyLimit,
    canUseAssistant,
    dayStartIso,
    normaliseGhanaPhone,
    phoneVariants,
    buildBuyLink,
    isNetworkVisible,
    cleanUserMessage,
    MAX_MESSAGE_CHARS,
} from '../ai-assistant/helpers.ts'

test('parseAssistantMode defaults to off for anything unknown', () => {
    assert.equal(parseAssistantMode('all'), 'all')
    assert.equal(parseAssistantMode(' Admins '), 'admins')
    assert.equal(parseAssistantMode(undefined), 'off')
    assert.equal(parseAssistantMode('yes'), 'off')
})

test('parseDailyLimit falls back to 30 and clamps to 1..500', () => {
    assert.equal(parseDailyLimit(undefined), 30)
    assert.equal(parseDailyLimit('abc'), 30)
    assert.equal(parseDailyLimit('0'), 1)
    assert.equal(parseDailyLimit('12'), 12)
    assert.equal(parseDailyLimit('99999'), 500)
})

test('canUseAssistant: off blocks everyone, admins mode lets only staff in', () => {
    assert.equal(canUseAssistant('off', 'admin', false), false)
    assert.equal(canUseAssistant('admins', 'admin', false), true)
    assert.equal(canUseAssistant('admins', 'sub-admin', false), true)
    assert.equal(canUseAssistant('admins', 'agent', false), false)
    assert.equal(canUseAssistant('all', 'customer', false), true)
})

test('canUseAssistant: sub-agents never get it (white-label portal)', () => {
    assert.equal(canUseAssistant('all', 'customer', true), false)
    assert.equal(canUseAssistant('all', 'agent', true), false)
})

test('dayStartIso is Accra (UTC+0) midnight', () => {
    assert.equal(dayStartIso(new Date('2026-11-18T23:59:00Z')), '2026-11-18T00:00:00.000Z')
    assert.equal(dayStartIso(new Date('2026-11-18T00:00:01Z')), '2026-11-18T00:00:00.000Z')
})

test('normaliseGhanaPhone accepts 0XXXXXXXXX, 233XXXXXXXXX, +233 and spaces', () => {
    assert.equal(normaliseGhanaPhone('0241234567'), '0241234567')
    assert.equal(normaliseGhanaPhone('233241234567'), '0241234567')
    assert.equal(normaliseGhanaPhone('+233 24 123 4567'), '0241234567')
    assert.equal(normaliseGhanaPhone('024-123-4567'), '0241234567')
    assert.equal(normaliseGhanaPhone('12345'), null)
    assert.equal(normaliseGhanaPhone(''), null)
})

test('phoneVariants covers both stored formats', () => {
    assert.deepEqual(phoneVariants('0241234567'), ['0241234567', '233241234567'])
    assert.deepEqual(phoneVariants('bad'), [])
})

test('buildBuyLink encodes network, package and optional phone', () => {
    assert.equal(
        buildBuyLink('Special MTN Mashup', 'pkg-1', null),
        '/dashboard/data-packages?network=Special+MTN+Mashup&package=pkg-1',
    )
    assert.equal(
        buildBuyLink('MTN', 'pkg-2', '0241234567'),
        '/dashboard/data-packages?network=MTN&package=pkg-2&phone=0241234567',
    )
})

test('isNetworkVisible respects the three MTN hide switches', () => {
    const hidden = { mashup: true, express: false, standard: true }
    assert.equal(isNetworkVisible('Special MTN Mashup', hidden), false)
    assert.equal(isNetworkVisible('EXPRESS MTN', hidden), true)
    assert.equal(isNetworkVisible('MTN', hidden), false)
    assert.equal(isNetworkVisible('Telecel', hidden), true)
})

test('cleanUserMessage trims, rejects empty and over-long input', () => {
    assert.equal(cleanUserMessage('  hi  '), 'hi')
    assert.equal(cleanUserMessage('   '), null)
    assert.equal(cleanUserMessage(42 as unknown as string), null)
    assert.equal(cleanUserMessage('x'.repeat(MAX_MESSAGE_CHARS)), 'x'.repeat(MAX_MESSAGE_CHARS))
    assert.equal(cleanUserMessage('x'.repeat(MAX_MESSAGE_CHARS + 1)), null)
})

import {
    resolveAssistantModel,
    isStaffRole,
    escapeLike,
    knowledgeSearchTerms,
    rankKnowledge,
} from '../ai-assistant/helpers.ts'

test('resolveAssistantModel: known setting wins, else env, else deepseek-chat', () => {
    assert.equal(resolveAssistantModel('deepseek-reasoner', 'deepseek-chat'), 'deepseek-reasoner')
    assert.equal(resolveAssistantModel('gpt-4', 'deepseek-chat'), 'deepseek-chat')
    assert.equal(resolveAssistantModel(undefined, ''), 'deepseek-chat')
})

test('isStaffRole only for admin and sub-admin', () => {
    assert.equal(isStaffRole('admin'), true)
    assert.equal(isStaffRole('sub-admin'), true)
    assert.equal(isStaffRole('dealer'), false)
    assert.equal(isStaffRole(undefined), false)
})

test('escapeLike escapes %, _ and backslash', () => {
    assert.equal(escapeLike('100%_off\\'), '100\\%\\_off\\\\')
})

test('knowledgeSearchTerms keeps only safe content words, max 5', () => {
    assert.deepEqual(knowledgeSearchTerms('How do I get a REFUND for my failed order?'), ['get', 'refund', 'failed', 'order'])
    assert.deepEqual(knowledgeSearchTerms('%,),(or=id.neq.0'), ['neq'])
    assert.deepEqual(knowledgeSearchTerms(''), [])
    assert.equal(knowledgeSearchTerms('alpha bravo charlie delta echo foxtrot golf').length, 5)
})

test('rankKnowledge puts question matches first and drops non-matches', () => {
    const rows = [
        { id: '1', category: 'orders', question: 'Delivery time', answer: 'Minutes; refund if failed' },
        { id: '2', category: 'refunds', question: 'How refunds work', answer: 'Wallet refund' },
        { id: '3', category: 'agents', question: 'Become an agent', answer: 'Upgrade' },
    ]
    assert.deepEqual(rankKnowledge(rows, ['refund']).map(r => r.id), ['2', '1'])
    assert.deepEqual(rankKnowledge(rows, ['zzz']), [])
})
