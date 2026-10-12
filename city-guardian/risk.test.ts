import { describe, expect, test } from 'bun:test'
import { decodeAbiParameters, getAddress, keccak256, parseAbiParameters, toBytes } from 'viem'
import {
  ACTION_EVACUATE,
  CRE_SATPAM,
  drawdownBps,
  encodeEvacuationReport,
  mergeRisk,
  planHashOf,
  ruleAssessment,
  type SourceMetrics,
  type Thresholds,
} from './risk'

const T: Thresholds = { drawdownHighBps: 200, drawdownMediumBps: 50, apyOutlierPct: 25 }
const ONE = 10n ** 18n
const calm: SourceMetrics = { reachable: true, netApy: 0.015, warnings: [] }
const CITY = getAddress('0x0000000000000000000000000000000000c17110')
const ADAPTER = getAddress('0x0000000000000000000000000000000000000ada')

describe('constants', () => {
  test('CRE_SATPAM matches the Solidity constant address(uint160(uint256(keccak256("city-vault.cre-satpam"))))', () => {
    const h = keccak256(toBytes('city-vault.cre-satpam'))
    expect(CRE_SATPAM.toLowerCase()).toBe(`0x${h.slice(26)}`)
    expect(CRE_SATPAM).toBe(getAddress(CRE_SATPAM))
  })
})

describe('drawdownBps', () => {
  test('is zero at or above the high-water mark', () => {
    expect(drawdownBps(ONE, ONE)).toBe(0n)
    expect(drawdownBps(ONE + 5n, ONE)).toBe(0n)
  })
  test('measures the fall in basis points', () => {
    expect(drawdownBps((ONE * 98n) / 100n, ONE)).toBe(200n)
    expect(drawdownBps(ONE / 2n, ONE)).toBe(5000n)
  })
  test('a zero high-water mark means nothing to compare with', () => {
    expect(drawdownBps(0n, 0n)).toBe(0n)
  })
})

describe('ruleAssessment', () => {
  test('a healthy city next to a calm source is LOW', () => {
    const a = ruleAssessment({ pricePerShare: ONE, highWaterMark: ONE }, calm, T)
    expect(a.level).toBe('LOW')
    expect(a.reasons).toEqual([])
  })
  test('a drawdown past the medium threshold is MEDIUM, past the high threshold is HIGH', () => {
    expect(ruleAssessment({ pricePerShare: (ONE * 99n) / 100n, highWaterMark: ONE }, calm, T).level).toBe('MEDIUM')
    expect(ruleAssessment({ pricePerShare: (ONE * 97n) / 100n, highWaterMark: ONE }, calm, T).level).toBe('HIGH')
  })
  test('exactly at a threshold counts', () => {
    expect(ruleAssessment({ pricePerShare: (ONE * 9950n) / 10000n, highWaterMark: ONE }, calm, T).level).toBe('MEDIUM')
    expect(ruleAssessment({ pricePerShare: (ONE * 98n) / 100n, highWaterMark: ONE }, calm, T).level).toBe('HIGH')
  })
  test('a RED warning at the source is HIGH, a YELLOW one is MEDIUM', () => {
    const calmCity = { pricePerShare: ONE, highWaterMark: ONE }
    expect(ruleAssessment(calmCity, { ...calm, warnings: [{ type: 'unrecognized_oracle', level: 'RED' }] }, T).level).toBe('HIGH')
    expect(ruleAssessment(calmCity, { ...calm, warnings: [{ type: 'low_liquidity', level: 'yellow' }] }, T).level).toBe('MEDIUM')
  })
  test('an APY outlier at the source is MEDIUM, never HIGH on its own', () => {
    expect(ruleAssessment({ pricePerShare: ONE, highWaterMark: ONE }, { ...calm, netApy: 0.4 }, T).level).toBe('MEDIUM')
  })
  test('an unreachable source is never a reason to evacuate', () => {
    const a = ruleAssessment({ pricePerShare: ONE, highWaterMark: ONE }, { reachable: false, warnings: [] }, T)
    expect(a.level).toBe('LOW')
    expect(a.reasons.join(' ')).toContain('unavailable')
  })
  test('the levels combine upward, never downward', () => {
    const a = ruleAssessment({ pricePerShare: (ONE * 99n) / 100n, highWaterMark: ONE }, { ...calm, warnings: [{ type: 'x', level: 'RED' }] }, T)
    expect(a.level).toBe('HIGH')
    expect(a.reasons.length).toBe(2)
  })
  test('the demo switch forces HIGH and says so', () => {
    const a = ruleAssessment({ pricePerShare: ONE, highWaterMark: ONE }, calm, T, true)
    expect(a.level).toBe('HIGH')
    expect(a.reasons.join(' ')).toContain('DEMO')
  })
})

describe('mergeRisk: the LLM can raise a risk the rules already see, never create or lower one', () => {
  const low = { level: 'LOW' as const, reasons: [] }
  const medium = { level: 'MEDIUM' as const, reasons: ['m'] }
  const high = { level: 'HIGH' as const, reasons: ['h'] }
  test('no LLM reply changes nothing', () => {
    expect(mergeRisk(medium, null)).toEqual(medium)
  })
  test('LLM HIGH on a LOW city becomes only MEDIUM (cannot trigger an evacuation alone)', () => {
    expect(mergeRisk(low, { risk: 'HIGH', reason: 'panic' }).level).toBe('MEDIUM')
  })
  test('LLM HIGH on a MEDIUM city becomes HIGH', () => {
    expect(mergeRisk(medium, { risk: 'HIGH', reason: 'real' }).level).toBe('HIGH')
  })
  test('LLM LOW never lowers a rule-based level', () => {
    expect(mergeRisk(medium, { risk: 'LOW', reason: 'fine' }).level).toBe('MEDIUM')
    expect(mergeRisk(high, { risk: 'LOW', reason: 'fine' }).level).toBe('HIGH')
  })
  test('the LLM reason is kept for the audit trail', () => {
    expect(mergeRisk(medium, { risk: 'MEDIUM', reason: 'watch it' }).reasons.at(-1)).toBe('LLM (MEDIUM): watch it')
  })
})

describe('report encoding', () => {
  test('the payload decodes exactly as CityGuardian._processReport expects', () => {
    const planHash = planHashOf({ city: CITY, adapter: ADAPTER, level: 'HIGH', reasons: ['r'], scheduledAt: 1_000n })
    const data = encodeEvacuationReport({ target: CRE_SATPAM, city: CITY, adapter: ADAPTER, planHash, chainSelector: 2183018362218727504n, scheduledAt: 1_000n })
    const [target, city, action, adapter, hash, selector, scheduledAt] = decodeAbiParameters(
      parseAbiParameters('address, address, uint8, address, bytes32, uint64, uint256'),
      data,
    )
    expect(target).toBe(CRE_SATPAM)
    expect(city).toBe(CITY)
    expect(action).toBe(ACTION_EVACUATE)
    expect(adapter).toBe(ADAPTER)
    expect(hash).toBe(planHash)
    expect(selector).toBe(2183018362218727504n)
    expect(scheduledAt).toBe(1_000n)
    expect((data.length - 2) / 2).toBe(224)
  })
  test('the plan hash depends on every input and is stable', () => {
    const base = { city: CITY, adapter: ADAPTER, level: 'HIGH' as const, reasons: ['a'], scheduledAt: 1n }
    expect(planHashOf(base)).toBe(planHashOf({ ...base }))
    expect(planHashOf(base)).not.toBe(planHashOf({ ...base, scheduledAt: 2n }))
    expect(planHashOf(base)).not.toBe(planHashOf({ ...base, reasons: ['b'] }))
    expect(planHashOf(base)).not.toBe(planHashOf({ ...base, adapter: CITY }))
  })
})
