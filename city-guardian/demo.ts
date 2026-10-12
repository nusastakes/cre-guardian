// Demo helper for the CRE simulation on Monad testnet. It sends real testnet transactions.
//
//   set -a; . ../../.env; . ../.env; set +a       # DEPLOYER_PRIVATE_KEY, CRE_ETH_PRIVATE_KEY, MONAD_TESTNET_RPC
//   bun run demo.ts setup     # found a demo city, fund it, enable the CRE satpam, point the guardian at the simulation forwarder
//   bun run demo.ts status    # print the demo city and the guardian configuration
//   bun run demo.ts restore   # undo the guardian configuration and revoke the satpam
//   bun run demo.ts satpam-on | satpam-off   # only the mayor's switch, for read-only simulations
//
// The mock forwarder used by `cre workflow simulate --broadcast` does not verify signatures, so while `setup` is in
// effect anybody could submit a report to the guardian. The effect is limited to pulling money to idle in cities whose
// mayor enabled the CRE satpam, and this script restores the real forwarder afterwards. Never run it against mainnet.

import { createPublicClient, createWalletClient, defineChain, getAddress, http, parseAbi, parseEventLogs, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CRE_SATPAM } from './risk'

const RPC = process.env.MONAD_TESTNET_RPC || 'https://testnet-rpc.monad.xyz'
const FACTORY = '0x6765F0C80F6a7D5EC7Af120d12e81628F641508E' as const
const GUARDIAN = '0x083899bEE8138E5f951db568926393FDb1F418A2' as const
const MIRROR_IMPL = '0x25BcA4f0ea34F115Cb7c620626fBBa95647E8690' as const
const AUSD = '0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC' as const
const RELAYER = process.env.RELAYER_URL || 'https://relayer-production-39e1.up.railway.app'
/** The forwarder `cre workflow simulate --broadcast` writes through on Monad testnet. */
const SIMULATION_FORWARDER = '0xB9F79d863261869B234c481D1f9A7af84AeAd192' as const
/** The forwarder the guardian was deployed with (contracts/deployments/monad-testnet.json: creForwarder). */
const REAL_FORWARDER = '0xF8344CFd5c43616a4366C34E3EEE75af79a74482' as const
const CITY_NAME = 'Satpam demo'
const DEPOSIT = 1_000_000_000n // 1,000 AUSD (6 decimals)
const SIMULATOR_TOP_UP = 2n * 10n ** 18n // 2 MON for the simulator key

const chain = defineChain({ id: 10143, name: 'Monad Testnet', nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } })
const pub = createPublicClient({ chain, transport: http(RPC) })

const factoryAbi = parseAbi([
  'function createCity(string name, string community, uint16 feeBps, address[] adapterImpls, string mapURI) returns (address vault)',
  'event CityCreated(address indexed vault, address indexed mayor, string name, string community, uint16 feeBps, string mapURI)',
])
const vaultAbi = parseAbi([
  'function adapters() view returns (address[])',
  'function totalAssets() view returns (uint256)',
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function rebalance(address from, address to, uint256 amount, bytes32 planHash)',
])
const adapterAbi = parseAbi(['function totalAssets() view returns (uint256)'])
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'])
const guardianAbi = parseAbi([
  'function owner() view returns (address)',
  'function getForwarderAddress() view returns (address)',
  'function setForwarderAddress(address)',
  'function identityEnforced() view returns (bool)',
  'function setIdentityEnforced(bool)',
  'function grantAgent(address city, address agent, uint8 role, uint64 expiry)',
  'function revokeAgent(address city, address agent)',
  'function isActiveAgent(address city, address agent, uint8 role) view returns (bool)',
])

const log = (...a: unknown[]) => console.log(...a)
const need = (name: string): `0x${string}` => {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set (source MainProject/.env and cre/.env first)`)
  return (v.startsWith('0x') ? v : `0x${v}`) as `0x${string}`
}

/** Monad charges the gas LIMIT x maxFeePerGas up front, so keep the cap tight. */
async function fees() {
  const block = await pub.getBlock()
  const tip = await pub.estimateMaxPriorityFeePerGas().catch(() => 0n)
  return { maxFeePerGas: (block.baseFeePerGas! * 3n) / 2n + tip, maxPriorityFeePerGas: tip }
}

const deployer = privateKeyToAccount(need('DEPLOYER_PRIVATE_KEY'))
const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) })

async function send(label: string, params: any): Promise<`0x${string}`> {
  const gas = ((await pub.estimateContractGas({ ...params, account: deployer })) * 12n) / 10n
  const hash = await wallet.writeContract({ ...params, gas, ...(await fees()) })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${label} reverted (${hash})`)
  log(`  ${label}: ${hash}`)
  return hash
}

async function findDemoCity(): Promise<Address | null> {
  const infos = (await pub.readContract({
    address: FACTORY,
    abi: parseAbi([
      'function cityInfos(uint256 start, uint256 count) view returns ((address vault, address mayor, string name, string community, string mapURI, uint16 feeBps, uint64 createdAt, uint256 totalAssets, uint256 totalSupply, uint256 pricePerShare, address[] adapters)[])',
    ]),
    functionName: 'cityInfos',
    args: [0n, 50n],
  })) as readonly { vault: Address; mayor: Address; name: string }[]
  const mine = infos.filter((c) => c.name === CITY_NAME && c.mayor.toLowerCase() === deployer.address.toLowerCase())
  return mine.length ? mine[mine.length - 1]!.vault : null
}

async function status() {
  const city = await findDemoCity()
  log('guardian owner:', await pub.readContract({ address: GUARDIAN, abi: guardianAbi, functionName: 'owner' }))
  log('guardian forwarder:', await pub.readContract({ address: GUARDIAN, abi: guardianAbi, functionName: 'getForwarderAddress' }))
  log('identityEnforced:', await pub.readContract({ address: GUARDIAN, abi: guardianAbi, functionName: 'identityEnforced' }))
  log('demo city:', city ?? '(none)')
  if (!city) return
  const [mirror] = (await pub.readContract({ address: city, abi: vaultAbi, functionName: 'adapters' })) as Address[]
  log('  totalAssets:', await pub.readContract({ address: city, abi: vaultAbi, functionName: 'totalAssets' }))
  log('  mirror adapter', mirror, 'holds', await pub.readContract({ address: mirror!, abi: adapterAbi, functionName: 'totalAssets' }))
  log('  satpam active:', await pub.readContract({ address: GUARDIAN, abi: guardianAbi, functionName: 'isActiveAgent', args: [city, CRE_SATPAM, 1] }))
}

async function setup() {
  const owner = await pub.readContract({ address: GUARDIAN, abi: guardianAbi, functionName: 'owner' })
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) throw new Error(`guardian owner is ${owner}, not the deployer`)
  const simulator = privateKeyToAccount(need('CRE_ETH_PRIVATE_KEY'))

  let city = await findDemoCity()
  if (city) {
    log('demo city already exists:', city)
  } else {
    log('1. found the demo city (the deployer is the mayor)')
    const args = [CITY_NAME, 'CRE demo', 1000, [MIRROR_IMPL], 'ipfs://cre-demo'] as const
    const hash = await send('createCity', { address: FACTORY, abi: factoryAbi, functionName: 'createCity', args })
    const receipt = await pub.getTransactionReceipt({ hash })
    city = parseEventLogs({ abi: factoryAbi, eventName: 'CityCreated', logs: receipt.logs })[0]!.args.vault
    log('  city', city)
  }

  const [mirror] = (await pub.readContract({ address: city, abi: vaultAbi, functionName: 'adapters' })) as Address[]
  const total = await pub.readContract({ address: city, abi: vaultAbi, functionName: 'totalAssets' })
  if (total === 0n) {
    log('2a. get test AUSD from the relayer faucet and deposit')
    const have = await pub.readContract({ address: AUSD, abi: tokenAbi, functionName: 'balanceOf', args: [deployer.address] })
    if (have < DEPOSIT) {
      const res = await fetch(`${RELAYER}/faucet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: deployer.address }) })
      const body = (await res.json()) as { hash?: string; error?: string }
      if (!res.ok) throw new Error(`faucet: ${res.status} ${JSON.stringify(body)}`)
      log('  faucet:', body.hash)
    }
    await send('approve', { address: AUSD, abi: tokenAbi, functionName: 'approve', args: [city, DEPOSIT] })
    await send('deposit', { address: city, abi: vaultAbi, functionName: 'deposit', args: [DEPOSIT, deployer.address] })
  }
  const held = await pub.readContract({ address: mirror!, abi: adapterAbi, functionName: 'totalAssets' })
  if (held === 0n) {
    // CityVault.maxShiftBps defaults to 5000: one rebalance may move at most half of the city.
    log('2b. move half of the city into the mirror adapter')
    await send('rebalance', { address: city, abi: vaultAbi, functionName: 'rebalance', args: ['0x0000000000000000000000000000000000000000', mirror, DEPOSIT / 2n, `0x${'00'.repeat(31)}01`] })
  } else {
    log('2b. the mirror adapter already holds', held.toString())
  }

  log('3. the mayor enables the CRE satpam for this city (7 days)')
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600)
  await send('grantAgent', { address: GUARDIAN, abi: guardianAbi, functionName: 'grantAgent', args: [city, CRE_SATPAM, 1, expiry] })

  log('4. the guardian owner points the guardian at the SIMULATION forwarder and switches identity enforcement off')
  await send('setForwarderAddress', { address: GUARDIAN, abi: guardianAbi, functionName: 'setForwarderAddress', args: [SIMULATION_FORWARDER] })
  await send('setIdentityEnforced(false)', { address: GUARDIAN, abi: guardianAbi, functionName: 'setIdentityEnforced', args: [false] })

  log('5. fund the simulator key', simulator.address)
  const bal = await pub.getBalance({ address: simulator.address })
  if (bal < SIMULATOR_TOP_UP / 2n) {
    const hash = await wallet.sendTransaction({ to: simulator.address, value: SIMULATOR_TOP_UP, gas: 21_000n, ...(await fees()) })
    await pub.waitForTransactionReceipt({ hash })
    log('  sent 2 MON:', hash)
  } else {
    log('  already has', bal.toString(), 'wei')
  }
  log('\nDEMO CITY', getAddress(city))
  log('Put it in config.staging.json as "demoForceHighCity", then run:')
  log('  cre workflow simulate city-guardian --target staging-settings --broadcast --non-interactive --trigger-index 0')
}

async function restore() {
  const city = await findDemoCity()
  log('1. restore the real forwarder and identity enforcement')
  await send('setForwarderAddress', { address: GUARDIAN, abi: guardianAbi, functionName: 'setForwarderAddress', args: [REAL_FORWARDER] })
  await send('setIdentityEnforced(true)', { address: GUARDIAN, abi: guardianAbi, functionName: 'setIdentityEnforced', args: [true] })
  if (city) {
    log('2. revoke the CRE satpam for the demo city')
    await send('revokeAgent', { address: GUARDIAN, abi: guardianAbi, functionName: 'revokeAgent', args: [city, CRE_SATPAM] })
  }
  await status()
}

/** Mayor-only switch for the CRE satpam of the demo city. It does not touch the forwarder, so it is safe on its own. */
async function satpam(on: boolean) {
  const city = await findDemoCity()
  if (!city) throw new Error('no demo city yet; run setup first')
  if (on) {
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600)
    await send('grantAgent', { address: GUARDIAN, abi: guardianAbi, functionName: 'grantAgent', args: [city, CRE_SATPAM, 1, expiry] })
  } else {
    await send('revokeAgent', { address: GUARDIAN, abi: guardianAbi, functionName: 'revokeAgent', args: [city, CRE_SATPAM] })
  }
}

const cmd = process.argv[2]
if (cmd === 'setup') await setup()
else if (cmd === 'restore') await restore()
else if (cmd === 'status') await status()
else if (cmd === 'satpam-on') await satpam(true)
else if (cmd === 'satpam-off') await satpam(false)
else {
  console.error('usage: bun run demo.ts setup | status | restore | satpam-on | satpam-off')
  process.exit(2)
}
