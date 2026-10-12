// Pure risk logic for the City Guardian workflow. No SDK calls here, so every rule is easy to test.
//
// Principle: the guardian contract can only move a city's funds toward idle (the safe side), and only when the mayor
// enabled the CRE "satpam". Even so, an LLM must never be able to trigger an evacuation on its own, so its opinion can
// only raise a risk that the deterministic rules already see.

import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters, toBytes, type Address, type Hex } from 'viem'

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

export const ACTION_EVACUATE = 1
/** CityGuardian.Role.SATPAM */
export const SATPAM_ROLE = 1
/** The marker address a mayor grants the SATPAM role to in order to accept CRE reports (CityGuardian.CRE_SATPAM). */
export const CRE_SATPAM: Address = getAddress(`0x${keccak256(toBytes('city-vault.cre-satpam')).slice(26)}`)

const ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 }
export const maxLevel = (a: RiskLevel, b: RiskLevel): RiskLevel => (ORDER[a] >= ORDER[b] ? a : b)

export interface Thresholds {
  /** Drawdown from the high-water mark that makes a city HIGH risk, in basis points. */
  drawdownHighBps: number
  /** Drawdown that makes it MEDIUM. */
  drawdownMediumBps: number
  /** An APY above this (in percent) at the source vault is treated as suspicious (MEDIUM). */
  apyOutlierPct: number
}

export interface SourceMetrics {
  /** False when the off-chain source could not be read. An outage is never a reason to evacuate. */
  reachable: boolean
  name?: string
  totalAssetsUsd?: number
  /** Net APY as a fraction, e.g. 0.015 for 1.5%. */
  netApy?: number
  warnings: { type: string; level: string }[]
}

export interface Assessment {
  level: RiskLevel
  reasons: string[]
}

/** How far the share price is below its high-water mark, in basis points (0 when at or above it). */
export function drawdownBps(price: bigint, highWaterMark: bigint): bigint {
  if (highWaterMark <= 0n || price >= highWaterMark) return 0n
  return ((highWaterMark - price) * 10_000n) / highWaterMark
}

export function ruleAssessment(
  input: { pricePerShare: bigint; highWaterMark: bigint },
  source: SourceMetrics,
  t: Thresholds,
  demoForceHigh = false,
): Assessment {
  let level: RiskLevel = 'LOW'
  const reasons: string[] = []

  const dd = drawdownBps(input.pricePerShare, input.highWaterMark)
  if (dd >= BigInt(t.drawdownHighBps)) {
    level = maxLevel(level, 'HIGH')
    reasons.push(`share price is ${dd} bps below its high-water mark (high threshold ${t.drawdownHighBps})`)
  } else if (dd >= BigInt(t.drawdownMediumBps)) {
    level = maxLevel(level, 'MEDIUM')
    reasons.push(`share price is ${dd} bps below its high-water mark (medium threshold ${t.drawdownMediumBps})`)
  }

  if (!source.reachable) {
    reasons.push('source vault data unavailable; not treated as a risk')
  } else {
    for (const w of source.warnings) {
      const lv = w.level.toUpperCase()
      if (lv === 'RED') {
        level = maxLevel(level, 'HIGH')
        reasons.push(`source vault has a RED warning: ${w.type}`)
      } else if (lv === 'YELLOW') {
        level = maxLevel(level, 'MEDIUM')
        reasons.push(`source vault has a YELLOW warning: ${w.type}`)
      }
    }
    if (source.netApy !== undefined && source.netApy * 100 > t.apyOutlierPct) {
      level = maxLevel(level, 'MEDIUM')
      reasons.push(`source vault net APY ${(source.netApy * 100).toFixed(2)}% is above ${t.apyOutlierPct}%`)
    }
  }

  if (demoForceHigh) {
    level = 'HIGH'
    reasons.push('DEMO: artificial risk spike forced by workflow configuration')
  }
  return { level, reasons }
}

/**
 * Combines the rules with the LLM's opinion. The LLM can raise MEDIUM to HIGH, and can raise LOW to MEDIUM, but it can
 * never turn a rule-based LOW into HIGH, and it can never lower a rule-based level.
 */
export function mergeRisk(rule: Assessment, llm: { risk: RiskLevel; reason: string } | null): Assessment {
  if (!llm) return rule
  let level = rule.level
  if (llm.risk === 'HIGH') level = rule.level === 'LOW' ? 'MEDIUM' : 'HIGH'
  else if (llm.risk === 'MEDIUM' && rule.level === 'LOW') level = 'MEDIUM'
  return { level, reasons: [...rule.reasons, `LLM (${llm.risk}): ${llm.reason}`] }
}

/** Hash that goes on-chain with the report; the full reasoning is in the workflow logs. */
export function planHashOf(parts: {
  city: Address
  adapter: Address
  level: RiskLevel
  reasons: string[]
  scheduledAt: bigint
}): Hex {
  return keccak256(
    toBytes(
      JSON.stringify({
        city: parts.city.toLowerCase(),
        adapter: parts.adapter.toLowerCase(),
        level: parts.level,
        reasons: parts.reasons,
        scheduledAt: parts.scheduledAt.toString(),
      }),
    ),
  )
}

/**
 * Payload decoded by CityGuardian._processReport:
 * (address target, address city, uint8 action, address adapter, bytes32 planHash, uint64 chainSelector, uint256 scheduledAt)
 */
export function encodeEvacuationReport(p: {
  target: Address
  city: Address
  adapter: Address
  planHash: Hex
  chainSelector: bigint
  scheduledAt: bigint
}): Hex {
  return encodeAbiParameters(
    parseAbiParameters(
      'address target, address city, uint8 action, address adapter, bytes32 planHash, uint64 chainSelector, uint256 scheduledAt',
    ),
    [p.target, p.city, ACTION_EVACUATE, p.adapter, p.planHash, p.chainSelector, p.scheduledAt],
  )
}
