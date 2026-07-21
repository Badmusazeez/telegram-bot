import { Link } from 'react-router-dom'

export function HomePage() {
  return (
    <section className="hero-compose">
      <div className="hero-copy">
        <p className="brand-mark">FoldPredict</p>
        <h1>Will Apple release a foldable iPhone before 2028?</h1>
        <p className="lede">
          Stake GEN on YES or NO. GenLayer validators search trusted sources and settle the market
          on-chain — no centralized oracle.
        </p>
        <div className="cta-row">
          <Link className="btn primary" to="/bet">
            Place a bet
          </Link>
          <Link className="btn ghost" to="/prediction">
            View market
          </Link>
        </div>
      </div>
      <div className="hero-plane" aria-hidden="true">
        <div className="fold-stage">
          <div className="glass-panel left" />
          <div className="glass-hinge" />
          <div className="glass-panel right" />
          <div className="signal-line" />
        </div>
      </div>
    </section>
  )
}
