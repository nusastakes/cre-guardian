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





export const CityGuardianABI = [{"type":"function","name":"CRE_SATPAM","inputs":[],"outputs":[{"name":"","type":"address","internalType":"address"}],"stateMutability":"view"},{"type":"function","name":"isActiveAgent","inputs":[{"name":"city","type":"address","internalType":"address"},{"name":"agent","type":"address","internalType":"address"},{"name":"role","type":"uint8","internalType":"enumCityGuardian.Role"}],"outputs":[{"name":"","type":"bool","internalType":"bool"}],"stateMutability":"view"},{"type":"function","name":"lastScheduledAt","inputs":[{"name":"cityAdapterKey","type":"bytes32","internalType":"bytes32"}],"outputs":[{"name":"scheduledAt","type":"uint256","internalType":"uint256"}],"stateMutability":"view"},{"type":"function","name":"onReport","inputs":[{"name":"metadata","type":"bytes","internalType":"bytes"},{"name":"report","type":"bytes","internalType":"bytes"}],"outputs":[],"stateMutability":"nonpayable"}] as const

export class CityGuardian {
  constructor(
    private readonly client: EVMClient,
    public readonly address: Address,
  ) {}

  cRESATPAM(
    runtime: Runtime<unknown>,
  ): `0x${string}` {
    const callData = encodeFunctionData({
      abi: CityGuardianABI,
      functionName: 'CRE_SATPAM' as const,
    })

    const result = this.client
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to: this.address, data: callData }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result()

    return decodeFunctionResult({
      abi: CityGuardianABI,
      functionName: 'CRE_SATPAM' as const,
      data: bytesToHex(result.data),
    }) as `0x${string}`
  }

  isActiveAgent(
    runtime: Runtime<unknown>,
    city: `0x${string}`,
    agent: `0x${string}`,
    role: number,
  ): boolean {
    const callData = encodeFunctionData({
      abi: CityGuardianABI,
      functionName: 'isActiveAgent' as const,
      args: [city, agent, role],
    })

    const result = this.client
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to: this.address, data: callData }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result()

    return decodeFunctionResult({
      abi: CityGuardianABI,
      functionName: 'isActiveAgent' as const,
      data: bytesToHex(result.data),
    }) as boolean
  }

  lastScheduledAt(
    runtime: Runtime<unknown>,
    cityAdapterKey: `0x${string}`,
  ): bigint {
    const callData = encodeFunctionData({
      abi: CityGuardianABI,
      functionName: 'lastScheduledAt' as const,
      args: [cityAdapterKey],
    })

    const result = this.client
      .callContract(runtime, {
        call: encodeCallMsg({ from: zeroAddress, to: this.address, data: callData }),
        blockNumber: LAST_FINALIZED_BLOCK_NUMBER,
      })
      .result()

    return decodeFunctionResult({
      abi: CityGuardianABI,
      functionName: 'lastScheduledAt' as const,
      data: bytesToHex(result.data),
    }) as bigint
  }

  writeReportFromOnReport(
    runtime: Runtime<unknown>,
    metadata: `0x${string}`,
    report: `0x${string}`,
    gasConfig?: { gasLimit?: string },
  ) {
    const callData = encodeFunctionData({
      abi: CityGuardianABI,
      functionName: 'onReport' as const,
      args: [metadata, report],
    })

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

