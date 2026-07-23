import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  asNumber,
  contractAddress,
  createReadClient,
  createWriteClient,
  ExecutionResult,
  TransactionStatus,
  type BetInfo,
  type MarketInfo,
  type ResolutionResult,
  type TxRecord,
} from '../lib/genlayer'

const HISTORY_KEY = 'foldpredict.txHistory'

function loadHistory(): TxRecord[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') as TxRecord[]
  } catch {
    return []
  }
}

function saveHistory(records: TxRecord[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(records.slice(0, 50)))
}

export function useFoldPredict() {
  const [market, setMarket] = useState<MarketInfo | null>(null)
  const [statusLabel, setStatusLabel] = useState('Market Open')
  const [resolution, setResolution] = useState<ResolutionResult | null>(null)
  const [bet, setBet] = useState<BetInfo | null>(null)
  const [account, setAccount] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<string>('Market Open')
  const [history, setHistory] = useState<TxRecord[]>(() => loadHistory())

  const readClient = useMemo(() => createReadClient(), [])
  const writeClient = useMemo(() => {
    const key = import.meta.env.VITE_PRIVATE_KEY as `0x${string}` | undefined
    return createWriteClient(key ? { privateKey: key } : undefined)
  }, [])

  const ensureAddress = useCallback(async () => {
    if (!contractAddress) {
      throw new Error(
        'VITE_CONTRACT_ADDRESS is not set. In PowerShell from project root run: powershell -ExecutionPolicy Bypass -File scripts\\setup_frontend_env.ps1  then restart npm run dev',
      )
    }
    return contractAddress
  }, [])

  const pushHistory = useCallback((record: TxRecord) => {
    setHistory((prev) => {
      const next = [record, ...prev]
      saveHistory(next)
      return next
    })
  }, [])

  const refresh = useCallback(async () => {
    setError(null)
    const address = await ensureAddress()
    const [info, status, res] = await Promise.all([
      readClient.readContract({
        address,
        functionName: 'get_market_info',
        args: [],
      }) as Promise<MarketInfo>,
      readClient.readContract({
        address,
        functionName: 'get_market_status',
        args: [],
      }) as Promise<string>,
      readClient.readContract({
        address,
        functionName: 'get_resolution_result',
        args: [],
      }) as Promise<ResolutionResult>,
    ])
    setMarket(info)
    setStatusLabel(status)
    setResolution(res)
    if (res.settled) setPhase('Finalized')
    else if (info.market_status === 'PENDING_VALIDATION') setPhase('Pending Validation')
    else setPhase(status)

    const user = (writeClient.account?.address as string) || account
    if (user) {
      setAccount(user)
      const mine = (await readClient.readContract({
        address,
        functionName: 'get_bet',
        args: [user],
      })) as BetInfo
      setBet(mine)
    }
  }, [account, ensureAddress, readClient, writeClient])

  useEffect(() => {
    void refresh().catch((err: Error) => setError(err.message))
  }, [refresh])

  const connectDemoAccount = useCallback(() => {
    const addr = writeClient.account?.address as string
    setAccount(addr || '')
  }, [writeClient])

  const connectWallet = useCallback(async () => {
    if (!window.ethereum) {
      throw new Error('No browser wallet detected')
    }
    const accounts = (await window.ethereum.request({
      method: 'eth_requestAccounts',
    })) as string[]
    if (!accounts[0]) throw new Error('No account returned')
    setAccount(accounts[0])
  }, [])

  const waitAndTrack = useCallback(
    async (hash: string, label: string) => {
      setPhase('Pending Validation')
      pushHistory({
        hash,
        label,
        status: 'Pending Validation',
        at: new Date().toISOString(),
      })
      const receipt = await readClient.waitForTransactionReceipt({
        hash: hash as `0x${string}` & { length: 66 },
        status: TransactionStatus.ACCEPTED,
      })
      const ok =
        receipt.txExecutionResultName === ExecutionResult.FINISHED_WITH_RETURN ||
        receipt.statusName === TransactionStatus.ACCEPTED ||
        receipt.statusName === TransactionStatus.FINALIZED
      setPhase(ok ? 'Validator Consensus' : 'Pending Validation')
      pushHistory({
        hash,
        label,
        status: ok ? 'Validator Consensus' : 'Failed',
        at: new Date().toISOString(),
      })
      if (ok) {
        setPhase('Finalized')
        pushHistory({
          hash,
          label: `${label} finalized`,
          status: 'Finalized',
          at: new Date().toISOString(),
        })
      }
      return receipt
    },
    [pushHistory, readClient],
  )

  const placeBet = useCallback(
    async (side: 'YES' | 'NO', amountWei: bigint) => {
      setBusy(true)
      setError(null)
      try {
        const address = await ensureAddress()
        connectDemoAccount()
        setPhase('Bet Submitted')
        const hash = await writeClient.writeContract({
          address,
          functionName: side === 'YES' ? 'bet_yes' : 'bet_no',
          args: [],
          value: amountWei,
        })
        await waitAndTrack(String(hash), `Bet ${side}`)
        await refresh()
        setPhase('Bet Submitted')
        return hash
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        throw err
      } finally {
        setBusy(false)
      }
    },
    [connectDemoAccount, ensureAddress, refresh, waitAndTrack, writeClient],
  )

  const settle = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const address = await ensureAddress()
      setPhase('Pending Validation')
      const hash = await writeClient.writeContract({
        address,
        functionName: 'settle_market',
        args: [],
        value: 0n,
      })
      await waitAndTrack(String(hash), 'Settle market')
      await refresh()
      setPhase('Finalized')
      return hash
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      throw err
    } finally {
      setBusy(false)
    }
  }, [ensureAddress, refresh, waitAndTrack, writeClient])

  const claim = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const address = await ensureAddress()
      setPhase('Claim Reward')
      const hash = await writeClient.writeContract({
        address,
        functionName: 'claim_reward',
        args: [],
        value: 0n,
      })
      await waitAndTrack(String(hash), 'Claim reward')
      await refresh()
      setPhase('Claim Reward')
      return hash
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      throw err
    } finally {
      setBusy(false)
    }
  }, [ensureAddress, refresh, waitAndTrack, writeClient])

  return {
    market,
    statusLabel,
    resolution,
    bet,
    account,
    busy,
    error,
    phase,
    history,
    yesPool: asNumber(market?.total_yes),
    noPool: asNumber(market?.total_no),
    totalPool: asNumber(market?.total_pool),
    refresh,
    connectDemoAccount,
    connectWallet,
    placeBet,
    settle,
    claim,
  }
}
