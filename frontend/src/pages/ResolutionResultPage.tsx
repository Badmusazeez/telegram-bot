import { type ResolutionResult } from '../lib/genlayer'

export function ResolutionResultPage({ resolution }: { resolution: ResolutionResult | null }) {
  if (!resolution) return <p className="muted">Loading resolution…</p>

  let sources: string[] = []
  try {
    sources = JSON.parse(resolution.sources || '[]') as string[]
  } catch {
    sources = []
  }

  return (
    <section className="page">
      <h1>Resolution result</h1>
      <p className="lede">
        {resolution.settled
          ? `Validators finalized outcome: ${resolution.outcome || '—'}`
          : 'Market has not been settled yet.'}
      </p>
      <dl className="detail-list">
        <div>
          <dt>Settled</dt>
          <dd>{resolution.settled ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt>Outcome</dt>
          <dd>{resolution.outcome || '—'}</dd>
        </div>
        <div>
          <dt>Device</dt>
          <dd>{resolution.device_name || '—'}</dd>
        </div>
        <div>
          <dt>Release date</dt>
          <dd>{resolution.release_date || '—'}</dd>
        </div>
        <div>
          <dt>Confidence (bps)</dt>
          <dd>{String(resolution.confidence_bps)}</dd>
        </div>
        <div>
          <dt>Market status</dt>
          <dd>{resolution.market_status}</dd>
        </div>
      </dl>
      {sources.length > 0 && (
        <div className="sources">
          <h2>Sources</h2>
          <ul>
            {sources.map((src) => (
              <li key={src}>
                <a href={src} target="_blank" rel="noreferrer">
                  {src}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
