// APY feed job: a second handler of this workflow that writes the APY of the catalog's yield services into ApyFeed
// through CRE reports, so the rates that drive every city's simulated yield are agreed by the DON instead of resting on
// the relayer's single key alone (the relayer keeper keeps writing too; whichever reading is newer wins).
//
// Each run takes ONE catalog source, chosen by time slot so the whole catalog is covered once per cycle:
//   1. reads ApyFeed.latest(sourceId) (one EVM read);
//   2. fetches the pool's APY history from DefiLlama Yields (`/chart/<pool>`, about 16 KB; one HTTP call, one node
//      fetches and the others reuse its answer);
//   3. writes abi.encode(target, sourceId, apyBps, observedAt, chainSelector) to ApyFeed, which accepts it only through
//      the CRE forwarder, only for itself and this chain, and only if observedAt is newer than what it holds.
// `sourceId` = keccak256 of the DefiLlama pool id, the same rule as the contracts, relayer and web app.

import {
  bytesToHex,
  consensusIdenticalAggregation,
  cre,
  encodeCallMsg,
  json,
  LAST_FINALIZED_BLOCK_NUMBER,
  ok,
  prepareReportRequest,
  TxStatus,
  type HTTPSendRequester,
  type Runtime,
} from '@chainlink/cre-sdk'
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { z } from 'zod'

/** The feed refuses anything above this (ApyFeed.MAX_APY_BPS); a volatile pool is written at the cap. */
export const FEED_MAX_APY_BPS = 5000

export const apyFeedConfigSchema = z.object({
  feedAddress: z.string(),
  /** Cron expression with seconds. */
  schedule: z.string(),
  /** Length of one slot; keep it equal to the cron interval so each run takes the next source. */
  rotationSeconds: z.number().int().min(1).default(120),
  sources: z.array(z.object({ id: z.string(), pool: z.string() })).min(1),
  yieldsApi: z.string().default('https://yields.llama.fi/chart/'),
  /** observedAt = DON time minus this margin, so it is never ahead of the block that includes the report. */
  safetySeconds: z.number().int().min(0).default(30),
  gasLimit: z.string().default('200000'),
})
export type ApyFeedConfig = z.infer<typeof apyFeedConfigSchema>

const feedAbi = parseAbi(['function latest(bytes32 sourceId) view returns (uint32 apyBps, uint64 observedAt, uint64 updatedAt)'])

export const sourceIdOf = (pool: string): Hex => keccak256(toHex(pool))

/** Which source this run writes. Pure, so every node picks the same one from the same consensus time. */
export function sourceForSlot<T>(sources: T[], rotationSeconds: number, nowSeconds: number): T {
  return sources[Math.floor(nowSeconds / rotationSeconds) % sources.length]
}

/** DefiLlama reports APY in percent (5.84 = 5.84%). Rounded to basis points and clamped to the feed's range. */
export function percentToFeedBps(apy: number): number {
  if (!Number.isFinite(apy) || apy <= 0) return 0
  return Math.min(FEED_MAX_APY_BPS, Math.round(apy * 100))
}

export function encodeApyReport(p: { target: Address; sourceId: Hex; apyBps: number; observedAt: bigint; chainSelector: bigint }): Hex {
  return encodeAbiParameters(parseAbiParameters('address target, bytes32 sourceId, uint32 apyBps, uint64 observedAt, uint64 chainSelector'), [
    p.target,
    p.sourceId,
    p.apyBps,
    p.observedAt,
    p.chainSelector,
  ])
}

// Only a boolean and a string cross the consensus boundary (whole numbers would become BigInt).
type ApyWire = { reachable: boolean; apy: string }

const fetchApy = (sendRequester: HTTPSendRequester, args: { url: string }): ApyWire => {
  const resp = sendRequester.sendRequest({ url: args.url, method: 'GET', cacheSettings: { store: true, maxAge: '60s' } }).result()
  if (!ok(resp)) return { reachable: false, apy: '' }
  const data = (json(resp) as { data?: { apy?: number }[] }).data
  const last = Array.isArray(data) && data.length ? data[data.length - 1] : null
  if (!last || typeof last.apy !== 'number') return { reachable: false, apy: '' }
  return { reachable: true, apy: String(last.apy) }
}

export function onApyFeedTrigger(runtime: Runtime<{ chainSelectorName: string; apyFeed?: ApyFeedConfig }>, chainSelector: bigint, evm: InstanceType<typeof cre.capabilities.EVMClient>): string {
  const cfg = runtime.config.apyFeed
  if (!cfg) return 'apy feed job not configured'
  const nowSeconds = Math.floor(runtime.now().getTime() / 1000)
  const source = sourceForSlot(cfg.sources, cfg.rotationSeconds, nowSeconds)
  const sourceId = sourceIdOf(source.pool)
  const feed = getAddress(cfg.feedAddress)

  const read = evm
    .callContract(runtime, {
      call: encodeCallMsg({ from: zeroAddress, to: feed, data: encodeFunctionData({ abi: feedAbi, functionName: 'latest', args: [sourceId] }) }),
      blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
    })
    .result()
  const [storedBps, storedObservedAt] = decodeFunctionResult({ abi: feedAbi, functionName: 'latest', data: bytesToHex(read.data) }) as readonly [number, bigint, bigint]

  const wire = new cre.capabilities.HTTPClient()
    .sendRequest(runtime, fetchApy, consensusIdenticalAggregation<ApyWire>())({ url: `${cfg.yieldsApi}${source.pool}` })
    .result()
  if (!wire.reachable) return `${source.id}: DefiLlama unreachable, nothing written`
  const apyBps = percentToFeedBps(Number(wire.apy))

  const observedAt = BigInt(nowSeconds - cfg.safetySeconds)
  if (observedAt <= storedObservedAt) return `${source.id}: feed already has a reading from ${storedObservedAt} (${storedBps} bps)`

  const report = encodeApyReport({ target: feed, sourceId, apyBps, observedAt, chainSelector })
  runtime.log(`APY ${source.id} ${apyBps} bps (DefiLlama ${wire.apy}%), feed had ${storedBps} bps`)
  const reportResponse = runtime.report(prepareReportRequest(report)).result()
  const write = evm.writeReport(runtime, { receiver: feed, report: reportResponse, gasConfig: { gasLimit: cfg.gasLimit } }).result()
  if (write.txStatus !== TxStatus.SUCCESS) throw new Error(`APY report failed for ${source.id}: ${write.errorMessage || write.txStatus}`)
  const txHash = bytesToHex(write.txHash || new Uint8Array(32))
  return `${source.id}: wrote ${apyBps} bps, tx ${txHash}`
}
