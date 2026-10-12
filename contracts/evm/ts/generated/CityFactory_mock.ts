// Code generated — DO NOT EDIT.
import type { Address } from 'viem'
import { addContractMock, type ContractMock, type EvmMock } from '@chainlink/cre-sdk/test'

import { CityFactoryABI } from './CityFactory'

export type CityFactoryMock = {
  cityCount?: () => bigint
  cityInfos?: (start: bigint, count: bigint) => readonly { vault: `0x${string}`; mayor: `0x${string}`; name: string; community: string; mapURI: string; feeBps: number; createdAt: bigint; totalAssets: bigint; totalSupply: bigint; pricePerShare: bigint; adapters: readonly `0x${string}`[] }[]
  isCity?: (arg0: `0x${string}`) => boolean
} & Pick<ContractMock<typeof CityFactoryABI>, 'writeReport'>

export function newCityFactoryMock(address: Address, evmMock: EvmMock): CityFactoryMock {
  return addContractMock(evmMock, { address, abi: CityFactoryABI }) as CityFactoryMock
}

