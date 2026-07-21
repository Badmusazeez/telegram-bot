import { NavLink } from 'react-router-dom'
import './Layout.css'

const links = [
  ['/', 'Home'],
  ['/prediction', 'Prediction'],
  ['/bet', 'Place Bet'],
  ['/my-bets', 'My Bets'],
  ['/status', 'Status'],
  ['/resolution', 'Resolution'],
  ['/history', 'History'],
] as const

export function Layout({
  children,
  phase,
  account,
  onConnect,
}: {
  children: React.ReactNode
  phase: string
  account: string
  onConnect: () => void
}) {
  return (
    <div className="shell">
      <div className="atmosphere" aria-hidden />
      <div className="fold-grid" aria-hidden />
      <header className="topbar">
        <NavLink to="/" className="brand">
          FoldPredict
        </NavLink>
        <nav className="nav" aria-label="Primary">
          {links.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="session">
          <span className="phase-line" title="Market phase">
            {phase}
          </span>
          {account ? (
            <span className="account">
              {account.slice(0, 6)}…{account.slice(-4)}
            </span>
          ) : (
            <button type="button" className="btn ghost compact" onClick={onConnect}>
              Connect
            </button>
          )}
        </div>
      </header>
      <main className="main">{children}</main>
      <footer className="footer">
        Adjudicated by GenLayer validators across Apple Newsroom, Reuters, Bloomberg, CNBC, The
        Verge, and TechCrunch.
      </footer>
    </div>
  )
}
