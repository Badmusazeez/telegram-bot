const STEPS = [
  'Market Open',
  'Bet Submitted',
  'Pending Validation',
  'Validator Consensus',
  'Finalized',
  'Claim Reward',
] as const

export function MarketStatusPage({
  statusLabel,
  phase,
  onSettle,
  busy,
}: {
  statusLabel: string
  phase: string
  onSettle: () => Promise<unknown>
  busy: boolean
}) {
  const activeIndex = Math.max(
    0,
    STEPS.findIndex((step) => phase.toLowerCase().includes(step.toLowerCase().split(' ')[0])),
  )

  return (
    <section className="page">
      <h1>Market status</h1>
      <p className="lede">
        Current contract status: <strong>{statusLabel}</strong>. Lifecycle phase:{' '}
        <strong>{phase}</strong>.
      </p>
      <ol className="timeline">
        {STEPS.map((step, index) => (
          <li key={step} className={index <= activeIndex ? 'done' : ''}>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      <button className="btn primary" type="button" disabled={busy} onClick={() => void onSettle()}>
        {busy ? 'Settling…' : 'Trigger settlement'}
      </button>
      <p className="muted small">
        Settlement searches Apple Newsroom, Apple.com, Apple Events, Reuters, Bloomberg, CNBC, The
        Verge, and TechCrunch. Only official releases count.
      </p>
    </section>
  )
}
