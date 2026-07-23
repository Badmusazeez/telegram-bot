import { createClient, createAccount } from 'genlayer-js'
import { localnet, studionet, testnetBradbury } from 'genlayer-js/chains'
import { TransactionStatus, ExecutionResult } from 'genlayer-js/types'
import type { Address } from 'viem'

const CHAINS = {
  localnet,
  studionet,
  testnetBradbury,
} as const

export type ChainName = keyof typeof CHAINS

function viteEnv(key: string, fallback = ''): string {
  const raw = (import.meta.env as Record<string, string | undefined>)[key]
  if (typeof raw !== 'string') return fallback
  return raw.replace(/^\uFEFF/, '').trim()
}

export const contractAddress = viteEnv('VITE_CONTRACT_ADDRESS') as Address

export const chainName = (viteEnv('VITE_CHAIN', 'localnet') ||
  'localnet') as ChainName
export const rpcUrl = viteEnv('VITE_RPC_URL') || undefined

export function getChain(name: ChainName = chainName) {
  return CHAINS[name]
}

/** Read-only client — no wallet required (genlayer-js docs pattern). */
export function createReadClient(name: ChainName = chainName) {
  return createClient({
    chain: getChain(name),
    ...(rpcUrl ? { endpoint: rpcUrl } : {}),
  })
}

/** Write client backed by a local account or browser wallet. */
export function createWriteClient(options?: {
  privateKey?: `0x${string}`
  address?: Address
  provider?: Window['ethereum']
  chain?: ChainName
}) {
  const chain = getChain(options?.chain ?? chainName)
  if (options?.privateKey) {
    const account = createAccount(options.privateKey)
    return createClient({
      chain,
      account,
      ...(rpcUrl ? { endpoint: rpcUrl } : {}),
    })
  }
  if (options?.address && options?.provider) {
    return createClient({
      chain,
      account: options.address,
      provider: options.provider,
      ...(rpcUrl ? { endpoint: rpcUrl } : {}),
    })
  }
  const account = createAccount()
  return createClient({
    chain,
    account,
    ...(rpcUrl ? { endpoint: rpcUrl } : {}),
  })
}

export { TransactionStatus, ExecutionResult, createAccount }

export type MarketInfo = {
  prediction_statement: string
  resolution_date: string
  market_status: string
  outcome: string
  total_yes: bigint | number | string
  total_no: bigint | number | string
  total_pool: bigint | number | string
  settled: boolean
  participant_count: bigint | number | string
}

export type ResolutionResult = {
  settled: boolean
  outcome: string
  device_name: string
  release_date: string
  confidence_bps: bigint | number | string
  sources: string
  market_status: string
}

export type BetInfo = {
  side: string
  stake: bigint | number | string
  claimed: boolean
  potential_payout: bigint | number | string
}

export type TxRecord = {
  hash: string
  label: string
  status: string
  at: string
}

export function asNumber(value: bigint | number | string | undefined): number {
  if (value === undefined || value === null) return 0
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number') return value
  return Number(value)
}

export function formatGen(wei: bigint | number | string): string {
  const n = asNumber(wei)
  return `${(n / 1e18).toLocaleString(undefined, { maximumFractionDigits: 6 })} GEN`
}
