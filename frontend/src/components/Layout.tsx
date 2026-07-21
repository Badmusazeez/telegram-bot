import { NavLink } from 'react-router-dom'
import './Layout.css'

const links = [
  ['/', 'Home'],
  ['/prediction', 'Prediction'],
  ['/bet', 'Place Bet'],
  ['/my-bets', 'My Bets'],
  ['/status', 'Market Status'],
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
      <header className="topbar">
        <NavLink to="/" className="brand">
          Fold<span>Predict</span>
        </NavLink>
        <nav className="nav">
          {links.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="session">
          <span className="phase-pill">{phase}</span>
          {account ? (
            <span className="account">{account.slice(0, 6)}…{account.slice(-4)}</span>
          ) : (
            <button type="button" className="ghost" onClick={onConnect}>
              Connect
            </button>
          )}
        </div>
      </header>
      <main className="main">{children}</main>
      <footer className="footer">
        Settled by GenLayer validators searching Apple Newsroom, Reuters, Bloomberg, and peers —
        not a centralized oracle.
      </footer>
    </div>
  )
}
