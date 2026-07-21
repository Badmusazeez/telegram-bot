import { Link } from 'react-router-dom'
import { asNumber, formatGen, type MarketInfo } from '../lib/genlayer'

export function PredictionDetailsPage({ market }: { market: MarketInfo | null }) {
  if (!market) return <p className="muted">Loading market…</p>
  const yes = asNumber(market.total_yes)
  const no = asNumber(market.total_no)
  const pool = Math.max(yes + no, 1)
  return (
    <section className="page">
      <h1>Prediction details</h1>
      <p className="lede">{market.prediction_statement}</p>
      <dl className="detail-list">
        <div>
          <dt>Resolution deadline</dt>
          <dd>{market.resolution_date}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{market.market_status}</dd>
        </div>
        <div>
          <dt>Participants</dt>
          <dd>{String(market.participant_count)}</dd>
        </div>
        <div>
          <dt>Total pool</dt>
          <dd>{formatGen(market.total_pool)}</dd>
        </div>
      </dl>
      <div className="odds">
        <div>
          <span>YES</span>
          <strong>{((yes / pool) * 100).toFixed(1)}%</strong>
          <em>{formatGen(yes)}</em>
        </div>
        <div>
          <span>NO</span>
          <strong>{((no / pool) * 100).toFixed(1)}%</strong>
          <em>{formatGen(no)}</em>
        </div>
      </div>
      <Link className="btn primary" to="/bet">
        Place bet
      </Link>
    </section>
  )
}
