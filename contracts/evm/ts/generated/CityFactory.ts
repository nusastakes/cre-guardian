// Code generated — DO NOT EDIT.
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeEventTopics,
  encodeFunctionData,
  zeroAddress,
} from 'viem'
import type { Address, Hex } from 'viem'
import {
  bytesToHex,
  encodeCallMsg,
  EVMClient,
  hexToBase64,
  LAST_FINALIZED_BLOCK_NUMBER,
  prepareReportRequest,
  type EVMLog,
  type Runtime,
} from '@chainlink/cre-sdk'

export interface DecodedLog<T> extends Omit<EVMLog, 'data'> { data: T }

const encodeTopicValue = (t: Hex | Hex[] | null): string[] => {
  if (t == null) return []
  if (Array.isArray(t)) return t.map(hexToBase64)
  return [hexToBase64(t)]
}





export const CityFactoryABI = [{"type":"function","name":"cityCount","inputs":[],"outputs":[{"name":"","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"cityInfos","inputs":[{"name":"start","type":"uint256","internalType":"uint256"},{"name":"count","type":"uint256","internalType":"uint256"}],"outputs":[{"name":"infos","type":"tuple[]","internalType":"structCityFactory.CityInfo[]","components":[{"name":"vault","type":"address","internalType":"address"},{"name":"mayor","type":"address","internalType":"address"},{"name":"name","type":"string","internalType":"string"},{"name":"community","type":"string","internalType":"string"},{"name":"mapURI","type":"string","internalType":"string"},{"name":"feeBps","type":"uint16","internalType":"uint16"},{"name":"createdAt","type":"uint64","internalType":"uint64"},{"name":"totalAssets","type":"uint256","internalType":"uint256"},{"name":"totalSupply","type":"uint256","internalType":"uint256"},{"name":"pricePerShare","type":"uint256","internalType":"uint256"},{"name":"adapters","type":"address[]","internalType":"address[]"}]}],"stateMutability":"view"},{"type":"function","name":"isCity","inputs":[{"name":"","type":"address","internalType":"address"}],"outputs":[{"name":"","type":"bool","internalType":"bool"}],"stateMutability":"view"}] as const

export class CityFactory {
  constructor(
    private readonly client: EVMClient,
    public readonly address: Address,
  ) {}

  cityCount(
    runtime: Runtime<unknown>,
  ): bigint {
    const callData = encodeFunctionData({
      abi: CityFactoryABI,
      functionName: 'cityCount' as const,
    })

    const result = this.client
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to: this.address, data: callData }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result()

    return decodeFunctionResult({
      abi: CityFactoryABI,
      functionName: 'cityCount' as const,
      data: bytesToHex(result.data),
    }) as bigint
  }

  cityInfos(
    runtime: Runtime<unknown>,
    start: bigint,
    count: bigint,
  ): readonly { vault: `0x${string}`; mayor: `0x${string}`; name: string; community: string; mapURI: string; feeBps: number; createdAt: bigint; totalAssets: bigint; totalSupply: bigint; pricePerShare: bigint; adapters: readonly `0x${string}`[] }[] {
    const callData = encodeFunctionData({
      abi: CityFactoryABI,
      functionName: 'cityInfos' as const,
      args: [start, count],
    })

    const result = this.client
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to: this.address, data: callData }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result()

    return decodeFunctionResult({
      abi: CityFactoryABI,
      functionName: 'cityInfos' as const,
      data: bytesToHex(result.data),
    }) as readonly { vault: `0x${string}`; mayor: `0x${string}`; name: string; community: string; mapURI: string; feeBps: number; createdAt: bigint; totalAssets: bigint; totalSupply: bigint; pricePerShare: bigint; adapters: readonly `0x${string}`[] }[]
  }

  isCity(
    runtime: Runtime<unknown>,
    arg0: `0x${string}`,
  ): boolean {
    const callData = encodeFunctionData({
      abi: CityFactoryABI,
      functionName: 'isCity' as const,
      args: [arg0],
    })

    const result = this.client
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to: this.address, data: callData }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result()

    return decodeFunctionResult({
      abi: CityFactoryABI,
      functionName: 'isCity' as const,
      data: bytesToHex(result.data),
    }) as boolean
  }

  writeReport(
    runtime: Runtime<unknown>,
    callData: Hex,
    gasConfig?: { gasLimit?: string },
  ) {
    const reportResponse = runtime
      .report(prepareReportRequest(callData))
      .result()

    return this.client
      .writeReport(runtime, {
        receiver: this.address,
        report: reportResponse,
        gasConfig,
      })
      .result()
  }
}

