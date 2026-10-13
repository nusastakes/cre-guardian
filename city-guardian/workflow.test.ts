import { describe, expect } from 'bun:test'
import { TxStatus } from '@chainlink/cre-sdk'
import { EvmMock, HttpActionsMock, newTestRuntime, test } from '@chainlink/cre-sdk/test'
import { decodeAbiParameters, getAddress, parseAbiParameters } from 'viem'
import { newCityFactoryMock } from '../contracts/evm/ts/generated/CityFactory_mock'
import { newCityGuardianMock } from '../contracts/evm/ts/generated/CityGuardian_mock'
import { newCityVaultMock } from '../contracts/evm/ts/generated/CityVault_mock'
import { newMirrorYieldAdapterMock } from '../contracts/evm/ts/generated/MirrorYieldAdapter_mock'
import { configSchema, onCronTrigger, windowStart, type Config } from './workflow'

const CHAIN_SELECTOR = 2183018362218727504n // monad-testnet
const FACTORY = getAddress('0x6765F0C80F6a7D5EC7Af120d12e81628F641508E')
const GUARDIAN = getAddress('0x083899bEE8138E5f951db568926393FDb1F418A2')
const CITY_A = getAddress('0x00000000000000000000000000000000000a0001')
const CITY_B = getAddress('0x00000000000000000000000000000000000b0002')
const ADAPTER_A1 = getAddress('0x0000000000000000000000000000000000a1a1a1')
const ADAPTER_A2 = getAddress('0x0000000000000000000000000000000000a2a2a2')
const ADAPTER_B1 = getAddress('0x0000000000000000000000000000000000b1b1b1')
const ONE = 10n ** 18n

const baseConfig = (over: Partial<Config> = {}): Config =>
  configSchema.parse({
    schedule: '0 */10 * * * *',
    chainSelectorName: 'monad-testnet',
    factoryAddress: FACTORY,
    guardianAddress: GUARDIAN,
    maxCities: 3,
    thresholds: { drawdownHighBps: 200, drawdownMediumBps: 50, apyOutlierPct: 25 },
    llm: { provider: 'none', model: 'claude-sonnet-5-5' },
    source: { morphoApi: 'https://blue-api.morpho.org/graphql', vault: '0x32841A8511D5c2c5b253f45668780B99139e476D', chainId: 143 },
    gasLimit: '450000',
    ...over,
  })

const info = (vault: `0x${string}`, name: string, pricePerShare: bigint, adapters: `0x${string}`[]) => ({
  vault,
  mayor: getAddress('0x00000000000000000000000000000000000000aa'),
  name,
  community: '',
  mapURI: '',
  feeBps: 1000,
  createdAt: 1n,
  totalAssets: 100_000_000n,
  totalSupply: 1n,
  pricePerShare,
  adapters,
})

interface Setup {
  evm: EvmMock
  reports: Uint8Array[]
  writes: number
  /** The (start, count) the workflow asked the factory for. */
  cityWindow?: [bigint, bigint]
}

/** Wires up the chain: which cities exist, whether the satpam is enabled, price vs high-water mark, adapter holdings. */
function setupChain(opts: {
  cities: ReturnType<typeof info>[]
  enabled?: Record<string, boolean>
  highWaterMark?: Record<string, bigint>
  holdings?: Record<string, bigint>
  /** What `cityCount` returns, when the factory holds more cities than the window the mock hands back. */
  totalCities?: number
}): Setup {
  const evm = EvmMock.testInstance(CHAIN_SELECTOR)
  const state: Setup = { evm, reports: [], writes: 0 }
  const factoryMock = newCityFactoryMock(FACTORY, evm)
  factoryMock.cityInfos = (start, count) => {
    state.cityWindow = [start, count]
    return opts.cities
  }
  factoryMock.cityCount = () => BigInt(opts.totalCities ?? opts.cities.length)
  newCityGuardianMock(GUARDIAN, evm).isActiveAgent = (city) => opts.enabled?.[getAddress(city)] ?? true
  for (const c of opts.cities) {
    newCityVaultMock(c.vault, evm).highWaterMark = () => opts.highWaterMark?.[c.vault] ?? ONE
    for (const a of c.adapters) {
      newMirrorYieldAdapterMock(a, evm).totalAssets = () => opts.holdings?.[a] ?? 50_000_000n
    }
  }
  evm.writeReport = ((input: any) => {
    state.writes += 1
    state.reports.push(input.report?.rawReport ?? new Uint8Array())
    return { txStatus: TxStatus.SUCCESS, txHash: new Uint8Array(32).fill(7) }
  }) as any
  return state
}

const calmSource = () => {
  const http = HttpActionsMock.testInstance()
  http.sendRequest = () => ({
    statusCode: 200,
    body: Buffer.from(JSON.stringify({ data: { vaultByAddress: { name: 'Grove', warnings: [], state: { totalAssetsUsd: 106000, netApy: 0.015 } } } })).toString('base64'),
  })
  return http
}

const runtimeWith = (config: Config) => {
  const runtime = newTestRuntime() as any
  runtime.config = config
  return runtime
}

describe('City Guardian workflow', () => {
  test('quiet run: healthy cities, calm source, no LLM call, no report', () => {
    const http = calmSource()
    let httpCalls = 0
    const inner = http.sendRequest!
    http.sendRequest = (i) => {
      httpCalls += 1
      return inner(i)
    }
    const chain = setupChain({
      cities: [info(CITY_A, 'Jakarta', ONE, [ADAPTER_A1]), info(CITY_B, 'Jogja', ONE, [ADAPTER_B1])],
    })
    const out = onCronTrigger(runtimeWith(baseConfig()))
    expect(out).toContain('Jakarta: LOW')
    expect(out).toContain('Jogja: LOW')
    expect(chain.writes).toBe(0)
    expect(httpCalls).toBe(1) // only the source vault; the LLM is not asked when everything is calm
  })

  test('a big drawdown evacuates every adapter that still holds funds, one report each', () => {
    calmSource()
    const chain = setupChain({
      cities: [info(CITY_A, 'Jakarta', (ONE * 96n) / 100n, [ADAPTER_A1, ADAPTER_A2]), info(CITY_B, 'Jogja', ONE, [ADAPTER_B1])],
      holdings: { [ADAPTER_A1]: 70_000_000n, [ADAPTER_A2]: 30_000_000n },
    })
    const out = onCronTrigger(runtimeWith(baseConfig()))
    expect(out).toContain('Jakarta: EVACUATED')
    expect(out).toContain('Jogja: LOW')
    expect(chain.writes).toBe(2)
  })

  test('adapters that hold nothing are not evacuated, so no gas is wasted', () => {
    calmSource()
    const chain = setupChain({
      cities: [info(CITY_A, 'Jakarta', (ONE * 96n) / 100n, [ADAPTER_A1, ADAPTER_A2])],
      holdings: { [ADAPTER_A1]: 0n, [ADAPTER_A2]: 30_000_000n },
    })
    onCronTrigger(runtimeWith(baseConfig()))
    expect(chain.writes).toBe(1)
  })

  test('a city whose mayor did not enable the CRE satpam is skipped even in a crash', () => {
    calmSource()
    const chain = setupChain({
      cities: [info(CITY_A, 'Jakarta', (ONE * 90n) / 100n, [ADAPTER_A1])],
      enabled: { [CITY_A]: false },
    })
    const out = onCronTrigger(runtimeWith(baseConfig()))
    expect(out).toContain('skipped (satpam not enabled)')
    expect(chain.writes).toBe(0)
  })

  test('the demo switch forces an evacuation for exactly one city', () => {
    calmSource()
    const chain = setupChain({
      cities: [info(CITY_A, 'Jakarta', ONE, [ADAPTER_A1]), info(CITY_B, 'Jogja', ONE, [ADAPTER_B1])],
    })
    const out = onCronTrigger(runtimeWith(baseConfig({ demoForceHighCity: CITY_B })))
    expect(out).toContain('Jakarta: LOW')
    expect(out).toContain('Jogja: EVACUATED')
    expect(chain.writes).toBe(1)
  })

  test('asks the factory for the configured window of cities', () => {
    calmSource()
    const chain = setupChain({ cities: [info(CITY_A, 'Jakarta', ONE, [ADAPTER_A1])] })
    onCronTrigger(runtimeWith(baseConfig({ firstCity: 3, maxCities: 2 })))
    expect(chain.cityWindow).toEqual([3n, 2n])
  })

  test('rotating walks the whole list: every slot watches the next window and the cycle starts over', () => {
    const cfg = { firstCity: 0, maxCities: 3, rotate: true, rotationSeconds: 600 }
    const starts = [0, 600, 1200, 1800, 2400, 3000, 3600, 4200, 4800].map((t) => windowStart(cfg, 21, t))
    expect(starts).toEqual([0, 3, 6, 9, 12, 15, 18, 0, 3])
    // Within one slot the window does not move; a short last window (22 cities) is still reached.
    expect(windowStart(cfg, 21, 599)).toBe(0)
    expect(windowStart(cfg, 22, 3600 * 1 + 600 * 0)).toBe(18)
    // Not rotating keeps the fixed window; an empty or small list falls back to the start.
    expect(windowStart({ ...cfg, rotate: false, firstCity: 8 }, 21, 1200)).toBe(8)
    expect(windowStart(cfg, 0, 1200)).toBe(0)
    expect(windowStart(cfg, 2, 1200)).toBe(0)
  })

  test('with rotate on, the workflow asks the factory for the window of the current slot', () => {
    calmSource()
    const chain = setupChain({ cities: [info(CITY_A, 'Jakarta', ONE, [ADAPTER_A1])], totalCities: 21 })
    const runtime = runtimeWith(baseConfig({ rotate: true, rotationSeconds: 600 }))
    const slot = Math.floor(runtime.now().getTime() / 1000 / 600)
    onCronTrigger(runtime)
    expect(chain.cityWindow).toEqual([BigInt((slot % 7) * 3), 3n])
  })

  test('the report payload names the guardian, the city, the adapter and a fresh timestamp', () => {
    calmSource()
    const chain = setupChain({ cities: [info(CITY_A, 'Jakarta', ONE, [ADAPTER_A1])] })
    onCronTrigger(runtimeWith(baseConfig({ demoForceHighCity: CITY_A })))
    expect(chain.writes).toBe(1)
    // The raw report carries a metadata header; the ABI payload is the last 224 bytes.
    const raw = chain.reports[0]
    const payload = raw.slice(raw.length - 224)
    const [target, city, action, adapter, , selector, scheduledAt] = decodeAbiParameters(
      parseAbiParameters('address, address, uint8, address, bytes32, uint64, uint256'),
      `0x${Buffer.from(payload).toString('hex')}`,
    )
    expect(target).toBe(GUARDIAN)
    expect(city).toBe(CITY_A)
    expect(action).toBe(1)
    expect(adapter).toBe(ADAPTER_A1)
    expect(selector).toBe(CHAIN_SELECTOR)
    expect(Number(scheduledAt)).toBeGreaterThan(1_700_000_000)
  })

  test('a RED warning at the source vault evacuates even if the cities look fine', () => {
    const http = HttpActionsMock.testInstance()
    http.sendRequest = () => ({
      statusCode: 200,
      body: Buffer.from(JSON.stringify({ data: { vaultByAddress: { name: 'Grove', warnings: [{ type: 'bad_debt', level: 'RED' }], state: { netApy: 0.015 } } } })).toString('base64'),
    })
    const chain = setupChain({ cities: [info(CITY_A, 'Jakarta', ONE, [ADAPTER_A1])] })
    const out = onCronTrigger(runtimeWith(baseConfig()))
    expect(out).toContain('EVACUATED')
    expect(chain.writes).toBe(1)
  })

  test('an unreachable source (HTTP 500) is not a reason to evacuate', () => {
    const http = HttpActionsMock.testInstance()
    http.sendRequest = () => ({ statusCode: 500, body: '' })
    const chain = setupChain({ cities: [info(CITY_A, 'Jakarta', ONE, [ADAPTER_A1])] })
    const out = onCronTrigger(runtimeWith(baseConfig()))
    expect(out).toContain('Jakarta: LOW')
    expect(chain.writes).toBe(0)
  })

  test('a failed report transaction is reported as an error, not swallowed', () => {
    calmSource()
    const chain = setupChain({ cities: [info(CITY_A, 'Jakarta', ONE, [ADAPTER_A1])] })
    chain.evm.writeReport = (() => ({ txStatus: TxStatus.REVERTED, errorMessage: 'NotActiveAgent', txHash: new Uint8Array(32) })) as any
    expect(() => onCronTrigger(runtimeWith(baseConfig({ demoForceHighCity: CITY_A })))).toThrow(/Evacuation report failed/)
  })

  test('with the LLM configured but no API key, the run continues on rules alone', () => {
    calmSource()
    const chain = setupChain({ cities: [info(CITY_A, 'Jakarta', (ONE * 99n) / 100n, [ADAPTER_A1])] })
    const out = onCronTrigger(runtimeWith(baseConfig({ llm: { provider: 'anthropic', model: 'claude-sonnet-5-5', maxTokens: 300 } })))
    expect(out).toContain('Jakarta: MEDIUM')
    expect(chain.writes).toBe(0)
  })
})

/** HTTP mock that answers the Morpho query and, separately, the LLM call; records which URLs were hit. */
function sourceAndLlm(llmText: string | null, llmStatus = 200, leadingBlocks: object[] = []) {
  const urls: string[] = []
  const bodies: string[] = []
  const http = HttpActionsMock.testInstance()
  http.sendRequest = (input: any) => {
    urls.push(String(input.url))
    if (String(input.url).includes('morpho.org')) {
      return {
        statusCode: 200,
        body: Buffer.from(JSON.stringify({ data: { vaultByAddress: { name: 'Grove', warnings: [], state: { totalAssetsUsd: 106000, netApy: 0.015 } } } })).toString('base64'),
      }
    }
    bodies.push(Buffer.from(input.body ?? '', 'base64').toString('utf8'))
    return {
      statusCode: llmStatus,
      body: Buffer.from(JSON.stringify({ content: llmText === null ? [...leadingBlocks] : [...leadingBlocks, { type: 'text', text: llmText }] })).toString('base64'),
    }
  }
  return { urls, bodies }
}

const withSecret = (name: string, value: string) => {
  const runtime = newTestRuntime(new Map([['main', new Map([[name, value]])]])) as any
  return runtime
}

const llmConfig = (provider: 'anthropic' | 'xkiro', model: string) =>
  baseConfig({ llm: { provider, model, maxTokens: 300 } })

describe('LLM second opinion', () => {
  const slightlyDown = () =>
    setupChain({ cities: [info(CITY_A, 'Jakarta', (ONE * 99n) / 100n, [ADAPTER_A1])] }) // 100 bps down: rules say MEDIUM

  test('anthropic: the LLM can raise a MEDIUM city to HIGH, which evacuates it', () => {
    const { urls, bodies } = sourceAndLlm('{"risk":"HIGH","reason":"Price is sliding and yield looks unsustainable."}')
    const chain = slightlyDown()
    const runtime = withSecret('ANTHROPIC_API_KEY', 'sk-test')
    runtime.config = llmConfig('anthropic', 'claude-sonnet-5-5')
    const out = onCronTrigger(runtime)
    expect(urls.some((u) => u.startsWith('https://api.anthropic.com/v1/messages'))).toBe(true)
    expect(JSON.parse(bodies[0]).model).toBe('claude-sonnet-5-5')
    expect(out).toContain('Jakarta: EVACUATED')
    expect(chain.writes).toBe(1)
  })

  test('xkiro: same flow through the gateway endpoint and its own secret', () => {
    const { urls } = sourceAndLlm('{"risk":"HIGH","reason":"Escalating."}')
    const chain = slightlyDown()
    const runtime = withSecret('XKIRO_API_KEY', 'xk-test')
    runtime.config = llmConfig('xkiro', 'anthropic/claude-sonnet-5')
    expect(onCronTrigger(runtime)).toContain('EVACUATED')
    expect(urls.some((u) => u.startsWith('https://api.xkiro.com/v1/messages'))).toBe(true)
    expect(chain.writes).toBe(1)
  })

  test('a reply that starts with a thinking block still yields the verdict from the text block', () => {
    sourceAndLlm('{"risk":"HIGH","reason":"Escalating."}', 200, [{ type: 'thinking', thinking: '', signature: 'abc' }])
    const chain = slightlyDown()
    const runtime = withSecret('ANTHROPIC_API_KEY', 'sk-test')
    runtime.config = llmConfig('anthropic', 'claude-sonnet-5-5')
    expect(onCronTrigger(runtime)).toContain('Jakarta: EVACUATED')
    expect(chain.writes).toBe(1)
  })

  test('the LLM saying LOW never cancels a rule-based MEDIUM, and MEDIUM does not evacuate', () => {
    sourceAndLlm('{"risk":"LOW","reason":"Looks fine."}')
    const chain = slightlyDown()
    const runtime = withSecret('ANTHROPIC_API_KEY', 'sk-test')
    runtime.config = llmConfig('anthropic', 'claude-sonnet-5-5')
    expect(onCronTrigger(runtime)).toContain('Jakarta: MEDIUM')
    expect(chain.writes).toBe(0)
  })

  test('an unusable or failing LLM reply falls back to the rules', () => {
    for (const [text, status] of [['not json at all', 200], [null, 200], ['{"risk":"HIGH","reason":"x"}', 500]] as const) {
      sourceAndLlm(text, status)
      const chain = slightlyDown()
      const runtime = withSecret('ANTHROPIC_API_KEY', 'sk-test')
      runtime.config = llmConfig('anthropic', 'claude-sonnet-5-5')
      expect(onCronTrigger(runtime)).toContain('Jakarta: MEDIUM')
      expect(chain.writes).toBe(0)
    }
  })

  test('on a quiet run the LLM is not called at all, so quiet runs cost nothing', () => {
    const { urls } = sourceAndLlm('{"risk":"HIGH","reason":"should never be asked"}')
    const chain = setupChain({ cities: [info(CITY_A, 'Jakarta', ONE, [ADAPTER_A1])] })
    const runtime = withSecret('ANTHROPIC_API_KEY', 'sk-test')
    runtime.config = llmConfig('anthropic', 'claude-sonnet-5-5')
    expect(onCronTrigger(runtime)).toContain('Jakarta: LOW')
    expect(urls.every((u) => u.includes('morpho.org'))).toBe(true)
    expect(chain.writes).toBe(0)
  })

  test('the API key is sent only in headers to the provider, never in the prompt', () => {
    const { bodies } = sourceAndLlm('{"risk":"MEDIUM","reason":"ok"}')
    slightlyDown()
    const runtime = withSecret('ANTHROPIC_API_KEY', 'sk-do-not-leak')
    runtime.config = llmConfig('anthropic', 'claude-sonnet-5-5')
    onCronTrigger(runtime)
    expect(bodies.length).toBe(1)
    expect(bodies[0]).not.toContain('sk-do-not-leak')
  })
})

describe('config', () => {
  test('refuses more than 3 cities, which would break the 15-read quota', () => {
    expect(() => baseConfig({ maxCities: 4 })).toThrow()
  })
  test('the shipped staging and production configs are valid', async () => {
    for (const f of ['config.staging.json', 'config.production.json']) {
      const json = await Bun.file(new URL(f, import.meta.url)).json()
      expect(() => configSchema.parse(json)).not.toThrow()
    }
  })
})
