// Code generated — DO NOT EDIT.
import type { Address } from 'viem'
import { addContractMock, type ContractMock, type EvmMock } from '@chainlink/cre-sdk/test'

import { CityGuardianABI } from './CityGuardian'

export type CityGuardianMock = {
  cRESATPAM?: () => `0x${string}`
  isActiveAgent?: (city: `0x${string}`, agent: `0x${string}`, role: number) => boolean
  lastScheduledAt?: (cityAdapterKey: `0x${string}`) => bigint
} & Pick<ContractMock<typeof CityGuardianABI>, 'writeReport'>

export function newCityGuardianMock(address: Address, evmMock: EvmMock): CityGuardianMock {
  return addContractMock(evmMock, { address, abi: CityGuardianABI }) as CityGuardianMock
}

