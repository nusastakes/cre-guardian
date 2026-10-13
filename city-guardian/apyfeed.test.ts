import { describe, expect, test } from 'bun:test'
import { decodeAbiParameters, keccak256, parseAbiParameters, toHex } from 'viem'
import { encodeApyReport, percentToFeedBps, sourceForSlot, sourceIdOf } from './apyfeed'

describe('apy feed job', () => {
  test('sourceId is keccak256 of the DefiLlama pool id (same rule as contracts, relayer, web)', () => {
    const pool = 'd795cb4c-e30f-52c0-8447-bf0853763a20'
    expect(sourceIdOf(pool)).toBe(keccak256(toHex(pool)))
    expect(sourceIdOf(pool)).toBe('0x13f92b67a678db0df21b2b01939bdea8fa2baabd6a1797a0c67ea167826a9bea')
  })

  test('rotation covers every source once per cycle', () => {
    const s = ['a', 'b', 'c']
    expect([0, 120, 240, 360].map((t) => sourceForSlot(s, 120, t))).toEqual(['a', 'b', 'c', 'a'])
  })

  test('percent to bps is rounded and clamped to the feed cap', () => {
    expect(percentToFeedBps(5.84244)).toBe(584)
    expect(percentToFeedBps(129.6)).toBe(5000)
    expect(percentToFeedBps(-1)).toBe(0)
    expect(percentToFeedBps(Number.NaN)).toBe(0)
  })

  test('report layout matches ApyFeed._processReport', () => {
    const target = '0x3328AEbB57Ee0bc8d2C7f68468dEe6B9b50926b5'
    const sourceId = sourceIdOf('x')
    const r = encodeApyReport({ target, sourceId, apyBps: 584, observedAt: 1_800_000_000n, chainSelector: 2183018362218727504n })
    const [t, s, a, o, c] = decodeAbiParameters(parseAbiParameters('address, bytes32, uint32, uint64, uint64'), r)
    expect(t).toBe(target)
    expect(s).toBe(sourceId)
    expect(a).toBe(584)
    expect(o).toBe(1_800_000_000n)
    expect(c).toBe(2183018362218727504n)
  })
})
