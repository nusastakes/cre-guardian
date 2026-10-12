// Code generated — DO NOT EDIT.
import type { Address } from 'viem'
import { addContractMock, type ContractMock, type EvmMock } from '@chainlink/cre-sdk/test'

import { CityVaultABI } from './CityVault'

export type CityVaultMock = {
  adapters?: () => readonly `0x${string}`[]
  highWaterMark?: () => bigint
  pricePerShare?: () => bigint
  totalAssets?: () => bigint
} & Pick<ContractMock<typeof CityVaultABI>, 'writeReport'>

export function newCityVaultMock(address: Address, evmMock: EvmMock): CityVaultMock {
  return addContractMock(evmMock, { address, abi: CityVaultABI }) as CityVaultMock
}

