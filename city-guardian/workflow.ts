// City Guardian ("satpam"): a Chainlink CRE workflow that watches Nusastakes cities and, when risk is high, asks the
// on-chain CityGuardian to pull a city's funds back to idle.
//
// Every 10 minutes it:
//   1. reads the city list from CityFactory.cityInfos (one EVM read) and each city's high-water mark, whether the mayor
//      enabled the CRE satpam, and each adapter's position;
//   2. reads the off-chain source vault (Morpho GraphQL) that the simulated yield mirrors;
//   3. scores risk with deterministic rules, asks an LLM for a second opinion only when something looks off, and
//      merges the two so the LLM can raise but never create or lower a risk;
//   4. for HIGH risk, writes an evacuation report for every adapter that still holds funds.
//
// CRE service quotas: 15 EVM reads and 15 HTTP calls per run. With at most 3 cities this uses at most 1 + 3 x (1 + 1 +
// 2) = 13 reads and 2 HTTP calls.

import {
  bytesToHex,
  consensusIdenticalAggregation,
  cre,
  getNetwork,
  json,
  ok,
  text,
  TxStatus,
  type HTTPSendRequester,
  type Runtime,
} from '@chainlink/cre-sdk'
import { getAddress, type Address } from 'viem'
import { z } from 'zod'
import { CityFactory } from '../contracts/evm/ts/generated/CityFactory'
import { CityGuardian } from '../contracts/evm/ts/generated/CityGuardian'
import { CityVault } from '../contracts/evm/ts/generated/CityVault'
import { MirrorYieldAdapter } from '../contracts/evm/ts/generated/MirrorYieldAdapter'
import { buildLlmRequest, llmConfigSchema, parseLlmReply, replyText, type LlmReply } from './llm'
import {
  CRE_SATPAM,
  SATPAM_ROLE,
  encodeEvacuationReport,
  mergeRisk,
  planHashOf,
  ruleAssessment,
  type Assessment,
  type RiskLevel,
  type SourceMetrics,
} from './risk'

// ─── Config ────────────────────────────────────────────────
export const configSchema = z.object({
  // Cron expression with seconds; every 10 minutes is "0 */10 * * * *".
  schedule: z.string(),
  chainSelectorName: z.string(),
  factoryAddress: z.string(),
  guardianAddress: z.string(),
  /** At most 3, so the run stays inside the 15-read quota. */
  maxCities: z.number().int().min(1).max(3).default(3),
  /** Index in the factory's city list of the first city to watch. A window of `maxCities` cities starts here. */
  firstCity: z.number().int().min(0).default(0),
  /**
   * Walk the whole city list instead of one fixed window: each `rotationSeconds` slot watches the next window of
   * `maxCities` cities, so every city is covered once per cycle. `firstCity` is ignored. Costs one extra read.
   */
  rotate: z.boolean().default(false),
  /** Length of one rotation slot. Keep it equal to the cron interval so each run moves on to the next window. */
  rotationSeconds: z.number().int().min(1).default(600),
  thresholds: z.object({
    drawdownHighBps: z.number().int().min(1),
    drawdownMediumBps: z.number().int().min(1),
    apyOutlierPct: z.number().min(1),
  }),
  llm: llmConfigSchema,
  source: z.object({
    morphoApi: z.string(),
    vault: z.string(),
    chainId: z.number().int(),
  }),
  /** Gas limit for the report transaction. Monad charges the limit, so keep it close to what is needed. */
  gasLimit: z.string().default('450000'),
  /** For the demo only: forces HIGH risk for the city with this vault address, to show an evacuation on camera. */
  demoForceHighCity: z.string().optional(),
})
export type Config = z.infer<typeof configSchema>

// ─── HTTP helpers (run once per node, results agreed by consensus) ────────────────
// What crosses the consensus boundary is only booleans and strings. Numbers are risky there: the SDK turns whole
// numbers into BigInt, which cannot be serialized, so structured data is carried as one JSON string.
type SourceWire = { reachable: boolean; data: string }
const UNREACHABLE: SourceWire = { reachable: false, data: '' }

const toBase64 = (text: string): string => Buffer.from(new TextEncoder().encode(text)).toString('base64')

const fetchSource = (
  sendRequester: HTTPSendRequester,
  args: { api: string; vault: string; chainId: number },
): SourceWire => {
  const query =
    'query($a:String!,$c:Int!){ vaultByAddress(address:$a, chainId:$c){ name warnings { type level } state{ totalAssetsUsd netApy } } }'
  const resp = sendRequester
    .sendRequest({
      url: args.api,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: toBase64(JSON.stringify({ query, variables: { a: args.vault, c: args.chainId } })),
      // One node makes the call and the others reuse its answer, so every node sees identical data.
      cacheSettings: { store: true, maxAge: '60s' },
    })
    .result()
  if (!ok(resp)) return UNREACHABLE
  const vault = (json(resp) as { data?: { vaultByAddress?: any } }).data?.vaultByAddress
  if (!vault) return UNREACHABLE
  const metrics: SourceMetrics = {
    reachable: true,
    name: typeof vault.name === 'string' ? vault.name : undefined,
    totalAssetsUsd: typeof vault.state?.totalAssetsUsd === 'number' ? vault.state.totalAssetsUsd : undefined,
    netApy: typeof vault.state?.netApy === 'number' ? vault.state.netApy : undefined,
    warnings: Array.isArray(vault.warnings) ? vault.warnings.map((w: any) => ({ type: String(w.type), level: String(w.level) })) : [],
  }
  return { reachable: true, data: JSON.stringify(metrics) }
}

/** `detail` says why a reply was unusable (a string, so it can cross consensus). It never contains the API key. */
type LlmWire = { ok: boolean; risk?: RiskLevel; reason?: string; detail?: string }

const askLlm = (
  sendRequester: HTTPSendRequester,
  args: { url: string; headers: Record<string, string>; body: string },
): LlmWire => {
  const resp = sendRequester
    .sendRequest({
      url: args.url,
      method: 'POST',
      headers: args.headers,
      body: toBase64(args.body),
      cacheSettings: { store: true, maxAge: '60s' },
    })
    .result()
  if (!ok(resp)) return { ok: false, detail: `HTTP status ${resp.statusCode}: ${text(resp).slice(0, 200)}` }
  const body = text(resp)
  let payload: unknown = null
  try {
    payload = JSON.parse(body)
  } catch {
    return { ok: false, detail: `reply is not JSON: ${body.slice(0, 200)}` }
  }
  const reply = parseLlmReply(replyText(payload))
  return reply ? { ok: true, risk: reply.risk, reason: reply.reason } : { ok: false, detail: `reply has no usable verdict: ${body.slice(0, 300)}` }
}

// ─── Core ─────────────────────────────────────────────────
function networkOf(config: Config) {
  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: config.chainSelectorName, isTestnet: true })
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`)
  return network
}

interface CitySnapshot {
  city: Address
  name: string
  satpamEnabled: boolean
  pricePerShare: bigint
  highWaterMark: bigint
  totalAssets: bigint
  adapters: { address: Address; assets: bigint }[]
}

/**
 * Index of the first city to watch in this run. Fixed at `firstCity`, or, when rotating, the window for the current
 * time slot: with 21 cities and windows of 3, slot 0 watches cities 0 to 2, slot 1 cities 3 to 5, and so on, then it
 * starts over. Pure, so every node computes the same window from the same consensus time.
 */
export function windowStart(cfg: { firstCity: number; maxCities: number; rotate: boolean; rotationSeconds: number }, cityCount: number, nowSeconds: number): number {
  if (!cfg.rotate) return cfg.firstCity
  const windows = Math.max(1, Math.ceil(cityCount / cfg.maxCities))
  const slot = Math.floor(nowSeconds / cfg.rotationSeconds)
  return (slot % windows) * cfg.maxCities
}

function readCities(runtime: Runtime<Config>, guardian: CityGuardian, factory: CityFactory, evm: InstanceType<typeof cre.capabilities.EVMClient>): CitySnapshot[] {
  const cfg = runtime.config
  const first = cfg.rotate
    ? windowStart(cfg, Number(factory.cityCount(runtime)), Math.floor(runtime.now().getTime() / 1000))
    : cfg.firstCity
  if (cfg.rotate) runtime.log(`Rotating window: cities ${first} to ${first + cfg.maxCities - 1}`)
  const infos = factory.cityInfos(runtime, BigInt(first), BigInt(cfg.maxCities))
  return infos.map((info) => {
    const city = getAddress(info.vault)
    const satpamEnabled = guardian.isActiveAgent(runtime, city, CRE_SATPAM, SATPAM_ROLE)
    if (!satpamEnabled) {
      // The guardian would refuse the report, so skip the extra reads and any transaction.
      return { city, name: info.name, satpamEnabled, pricePerShare: info.pricePerShare, highWaterMark: 0n, totalAssets: info.totalAssets, adapters: [] }
    }
    const highWaterMark = new CityVault(evm, city).highWaterMark(runtime)
    const adapters = info.adapters.map((a) => ({ address: getAddress(a), assets: new MirrorYieldAdapter(evm, getAddress(a)).totalAssets(runtime) }))
    return { city, name: info.name, satpamEnabled, pricePerShare: info.pricePerShare, highWaterMark, totalAssets: info.totalAssets, adapters }
  })
}

export const onCronTrigger = (runtime: Runtime<Config>): string => {
  const config = runtime.config
  const network = networkOf(config)
  const evm = new cre.capabilities.EVMClient(network.chainSelector.selector)
  const factory = new CityFactory(evm, getAddress(config.factoryAddress))
  const guardian = new CityGuardian(evm, getAddress(config.guardianAddress))

  // 1. On-chain state.
  const cities = readCities(runtime, guardian, factory, evm)
  runtime.log(`Read ${cities.length} cities from the factory`)

  // 2. Off-chain source vault.
  let source: SourceMetrics = { reachable: false, warnings: [] }
  try {
    const wire = new cre.capabilities.HTTPClient()
      .sendRequest(runtime, fetchSource, consensusIdenticalAggregation<SourceWire>())({
        api: config.source.morphoApi,
        vault: config.source.vault,
        chainId: config.source.chainId,
      })
      .result()
    if (wire.reachable && wire.data) source = JSON.parse(wire.data) as SourceMetrics
  } catch (e) {
    runtime.log(`Source vault read failed: ${String(e)}`)
  }
  runtime.log(`Source vault: reachable=${source.reachable} netApy=${source.netApy ?? 'n/a'} warnings=${source.warnings.length}`)

  // 3. Deterministic risk per city.
  const demoCity = config.demoForceHighCity ? getAddress(config.demoForceHighCity) : undefined
  const rules = new Map<string, Assessment>()
  for (const c of cities) {
    if (!c.satpamEnabled) {
      runtime.log(`${c.name} (${c.city}): the mayor has not enabled the CRE satpam; skipping`)
      continue
    }
    const a = ruleAssessment({ pricePerShare: c.pricePerShare, highWaterMark: c.highWaterMark }, source, config.thresholds, demoCity === c.city)
    rules.set(c.city, a)
    runtime.log(`${c.name} (${c.city}): rules say ${a.level}${a.reasons.length ? ' - ' + a.reasons.join('; ') : ''}`)
  }

  // 4. A second opinion, only when something already looks off (saves cost and keeps quiet runs quiet).
  let llm: LlmReply | null = null
  const interesting = [...rules.values()].some((a) => a.level !== 'LOW')
  if (interesting && config.llm.provider !== 'none') {
    llm = askForOpinion(runtime, cities, rules, source)
  }

  // 5. Decide and act.
  const scheduledAt = BigInt(Math.floor(runtime.now().getTime() / 1000))
  const results: string[] = []
  for (const c of cities) {
    const rule = rules.get(c.city)
    if (!rule) {
      results.push(`${c.name}: skipped (satpam not enabled)`)
      continue
    }
    const final = mergeRisk(rule, llm)
    if (final.level !== 'HIGH') {
      results.push(`${c.name}: ${final.level}`)
      continue
    }
    const exposed = c.adapters.filter((a) => a.assets > 0n)
    if (exposed.length === 0) {
      results.push(`${c.name}: HIGH but nothing left in adapters`)
      continue
    }
    for (const adapter of exposed) {
      const planHash = planHashOf({ city: c.city, adapter: adapter.address, level: final.level, reasons: final.reasons, scheduledAt })
      const report = encodeEvacuationReport({
        target: guardian.address,
        city: c.city,
        adapter: adapter.address,
        planHash,
        chainSelector: network.chainSelector.selector,
        scheduledAt,
      })
      runtime.log(`EVACUATE ${c.name} adapter ${adapter.address} (${adapter.assets} units): ${final.reasons.join('; ')}`)
      const write = guardian.writeReport(runtime, report, { gasLimit: config.gasLimit })
      if (write.txStatus !== TxStatus.SUCCESS) {
        throw new Error(`Evacuation report failed for ${c.city}/${adapter.address}: ${write.errorMessage || write.txStatus}`)
      }
      const txHash = bytesToHex(write.txHash || new Uint8Array(32))
      runtime.log(`Report sent. tx ${txHash}, planHash ${planHash}`)
      results.push(`${c.name}: EVACUATED ${adapter.address} tx ${txHash}`)
    }
  }
  return results.join(' | ')
}

function askForOpinion(
  runtime: Runtime<Config>,
  cities: CitySnapshot[],
  rules: Map<string, Assessment>,
  source: SourceMetrics,
): LlmReply | null {
  const config = runtime.config
  const secretId = config.llm.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'XKIRO_API_KEY'
  let apiKey: string
  try {
    apiKey = runtime.getSecret({ id: secretId }).result().value
  } catch (e) {
    runtime.log(`No ${secretId} secret available (${String(e)}); continuing with rules only`)
    return null
  }
  const snapshot = {
    cities: cities
      .filter((c) => rules.has(c.city))
      .map((c) => ({
        name: c.name,
        pricePerShare: c.pricePerShare.toString(),
        highWaterMark: c.highWaterMark.toString(),
        totalAssets: c.totalAssets.toString(),
        ruleRisk: rules.get(c.city)!.level,
        ruleReasons: rules.get(c.city)!.reasons,
      })),
    sourceVault: source,
  }
  try {
    const req = buildLlmRequest(config.llm, apiKey, snapshot)
    const reply = new cre.capabilities.HTTPClient()
      .sendRequest(runtime, askLlm, consensusIdenticalAggregation<LlmWire>())({ url: req.url, headers: req.headers, body: req.body })
      .result()
    if (reply.ok && reply.risk && reply.reason) {
      runtime.log(`LLM opinion: ${reply.risk} - ${reply.reason}`)
      return { risk: reply.risk, reason: reply.reason }
    }
    runtime.log(`LLM reply was not usable (${reply.detail ?? 'no detail'}); continuing with rules only`)
  } catch (e) {
    runtime.log(`LLM call failed: ${String(e)}; continuing with rules only`)
  }
  return null
}

// ─── Workflow init ─────────────────────────────────────────
export function initWorkflow(config: Config) {
  const cron = new cre.capabilities.CronCapability()
  return [cre.handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)]
}
