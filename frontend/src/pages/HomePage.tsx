import { Link } from 'react-router-dom'
import { formatGen } from '../lib/genlayer'
import type { MarketInfo } from '../lib/genlayer'

export function HomePage({
  market,
  statusLabel,
  phase,
}: {
  market: MarketInfo | null
  statusLabel: string
  phase: string
}) {
  return (
    <section className="hero-compose">
      <p className="brand-mark">FoldPredict</p>
      <h1>Will Apple ship a foldable iPhone before 2028?</h1>
      <p className="lede">
        Stake GEN on YES or NO. When the deadline hits, GenLayer validators
        independently search trusted public sources and settle the market on-chain.
      </p>
      <div className="cta-row">
        <Link className="btn primary" to="/bet">
          Place a bet
        </Link>
        <Link className="btn ghost" to="/prediction">
          View market
        </Link>
      </div>
      <div className="hero-meta" aria-label="Market snapshot">
        <span>{statusLabel}</span>
        <span>{phase}</span>
        <span>Pool {formatGen(market?.total_pool ?? 0)}</span>
      </div>
      <div className="hero-plane" aria-hidden>
        <div className="fold-device">
          <div className="hinge" />
          <div className="panel left" />
          <div className="panel right" />
        </div>
      </div>
    </section>
  )
}
