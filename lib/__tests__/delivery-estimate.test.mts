// Run: npm test  (node --test with built-in TypeScript stripping; no deps)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    adjustMinutes,
    estimateLabel,
    strengthScore,
    formatDuration,
    computeChannelEstimate,
    isConfirmWorthy,
    tierText,
    type DeliverySignal,
} from '../delivery-estimate.ts'

const NOW = Date.parse('2026-10-18T12:00:00Z')
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

function signal(over: Partial<DeliverySignal> = {}): DeliverySignal {
    return {
        channel: 'MTN',
        cCreatedAt: null,
        cDeliveredAt: null,
        pCreatedAt: null,
        isManuallyDown: false,
        downReason: null,
        downSince: null,
        ...over,
    }
}

test('buffer: nothing subtracted up to 5 min, 5 subtracted above', () => {
    assert.equal(adjustMinutes(0), 0)
    assert.equal(adjustMinutes(5), 5)
    assert.equal(adjustMinutes(6), 1)
    assert.equal(adjustMinutes(65), 60)
})

test('label thresholds', () => {
    assert.equal(estimateLabel(9.99), 'instant')
    assert.equal(estimateLabel(10), 'minutes')
    assert.equal(estimateLabel(59.9), 'minutes')
    assert.equal(estimateLabel(60), 'validation_ongoing')
})

test('strength tiers are piecewise-linear with a floor of 1', () => {
    assert.deepEqual(strengthScore(0), { percent: 100, tier: 'Excellent' })
    assert.deepEqual(strengthScore(10), { percent: 100, tier: 'Excellent' })
    assert.deepEqual(strengthScore(20), { percent: 90, tier: 'Excellent' })
    assert.deepEqual(strengthScore(30), { percent: 80, tier: 'Excellent' })
    assert.deepEqual(strengthScore(30.01), { percent: 79, tier: 'Good' })
    assert.deepEqual(strengthScore(60), { percent: 50, tier: 'Good' })
    assert.deepEqual(strengthScore(61), { percent: 49, tier: 'Delayed' })
    assert.deepEqual(strengthScore(180), { percent: 20, tier: 'Delayed' })
    assert.equal(strengthScore(181).tier, 'Critical')
    assert.equal(strengthScore(100_000).percent, 1)
})

test('seconds vs minutes branches on precise seconds', () => {
    assert.equal(formatDuration({ minutes: 0, seconds: 0 }), '1 sec')
    assert.equal(formatDuration({ minutes: 0, seconds: 30 }), '30 sec')
    assert.equal(formatDuration({ minutes: 1, seconds: 31 }), '31 sec')
    assert.equal(formatDuration({ minutes: 1, seconds: 59 }), '59 sec')
    assert.equal(formatDuration({ minutes: 1, seconds: 60 }), '1 min')
    assert.equal(formatDuration(null), '')
})

test('a 5.1-minute raw delivery shows seconds, not "0 min"', () => {
    const est = computeChannelEstimate(signal({ cCreatedAt: at(10), cDeliveredAt: at(10 - 5.1) }), NOW)
    assert.equal(formatDuration(est.lastTook), '6 sec')
})

test('no C at all: no recent orders', () => {
    const est = computeChannelEstimate(signal(), NOW)
    assert.equal(est.state, 'no_recent')
    assert.equal(est.percent, null)
    assert.equal(tierText(est), 'No recent orders')
})

test('stale C (older than 24h): no recent orders', () => {
    const est = computeChannelEstimate(signal({ cCreatedAt: at(25 * 60), cDeliveredAt: at(25 * 60 - 2) }), NOW)
    assert.equal(est.state, 'no_recent')
    assert.equal(est.lastTook, null)
})

test('no P: Metric 2 falls back to Metric 1', () => {
    const est = computeChannelEstimate(signal({ cCreatedAt: at(20), cDeliveredAt: at(18) }), NOW)
    assert.equal(est.state, 'live')
    assert.deepEqual(est.current, est.lastTook)
    assert.equal(est.label, 'instant')
    assert.equal(est.headline, 'Instant Delivery Ongoing')
    assert.equal(formatDuration(est.lastTook), '2 min')
})

test('P ticks against now; strength stays on Metric 1', () => {
    const est = computeChannelEstimate(
        signal({ cCreatedAt: at(100), cDeliveredAt: at(98), pCreatedAt: at(75) }),
        NOW,
    )
    assert.deepEqual(est.current, { minutes: 70, seconds: 4200 })
    assert.equal(est.label, 'validation_ongoing')
    assert.equal(est.headline, 'Validation Ongoing')
    assert.equal(est.percent, 100)
    assert.equal(est.tier, 'Excellent')
    assert.equal(isConfirmWorthy(est), false)
})

test('manual override: frozen numbers, 0%, no label', () => {
    const est = computeChannelEstimate(
        signal({
            cCreatedAt: at(100), cDeliveredAt: at(98), pCreatedAt: at(60),
            isManuallyDown: true, downReason: 'Supplier outage', downSince: at(40),
        }),
        NOW,
    )
    assert.equal(est.state, 'down')
    assert.equal(est.percent, 0)
    assert.equal(est.label, null)
    assert.equal(est.headline, null)
    // P waited 20 min until marked down; it doesn't keep ticking to 60.
    assert.deepEqual(est.current, { minutes: 15, seconds: 900 })
    assert.equal(tierText(est), 'Experiencing delays')
    assert.equal(isConfirmWorthy(est), false)
})

test('confirm-worthy only when live, instant and healthy', () => {
    const fast = computeChannelEstimate(signal({ cCreatedAt: at(10), cDeliveredAt: at(8) }), NOW)
    assert.equal(isConfirmWorthy(fast), true)
    const slowHistory = computeChannelEstimate(signal({ cCreatedAt: at(200), cDeliveredAt: at(60) }), NOW)
    assert.equal(slowHistory.label, 'validation_ongoing')
    assert.equal(isConfirmWorthy(slowHistory), false)
    assert.equal(isConfirmWorthy(null), false)
})
