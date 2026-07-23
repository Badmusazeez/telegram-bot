import { asNumber, formatGen, type BetInfo } from '../lib/genlayer'

export function MyBetsPage({
  account,
  bet,
  onClaim,
  busy,
}: {
  account: string
  bet: BetInfo | null
  onClaim: () => Promise<unknown>
  busy: boolean
}) {
  if (!account) {
    return (
      <section className="page">
        <h1>My bets</h1>
        <p className="lede">Connect an account to inspect your position.</p>
      </section>
    )
  }

  const hasBet = Boolean(bet?.side)
  return (
    <section className="page">
      <h1>My bets</h1>
      <p className="lede">Position for {account}</p>
      {!hasBet ? (
        <p className="muted">No stake recorded for this address.</p>
      ) : (
        <dl className="detail-list">
          <div>
            <dt>Side</dt>
            <dd>{bet?.side}</dd>
          </div>
          <div>
            <dt>Stake</dt>
            <dd>{formatGen(bet?.stake ?? 0)}</dd>
          </div>
          <div>
            <dt>Potential payout</dt>
            <dd>{formatGen(bet?.potential_payout ?? 0)}</dd>
          </div>
          <div>
            <dt>Claimed</dt>
            <dd>{bet?.claimed ? 'Yes' : 'No'}</dd>
          </div>
        </dl>
      )}
      {hasBet && !bet?.claimed && asNumber(bet?.potential_payout) > 0 && (
        <button className="btn primary" type="button" disabled={busy} onClick={() => void onClaim()}>
          Claim Reward
        </button>
      )}
    </section>
  )
}
