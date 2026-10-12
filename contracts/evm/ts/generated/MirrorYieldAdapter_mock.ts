// Code generated — DO NOT EDIT.
import type { Address } from 'viem'
import { addContractMock, type ContractMock, type EvmMock } from '@chainlink/cre-sdk/test'

import { MirrorYieldAdapterABI } from './MirrorYieldAdapter'

export type MirrorYieldAdapterMock = {
  isSimulated?: () => boolean
  totalAssets?: () => bigint
} & Pick<ContractMock<typeof MirrorYieldAdapterABI>, 'writeReport'>

export function newMirrorYieldAdapterMock(address: Address, evmMock: EvmMock): MirrorYieldAdapterMock {
  return addContractMock(evmMock, { address, abi: MirrorYieldAdapterABI }) as MirrorYieldAdapterMock
}

