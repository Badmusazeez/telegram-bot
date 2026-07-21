import type { TxRecord } from '../lib/genlayer'

export function TransactionHistoryPage({ history }: { history: TxRecord[] }) {
  return (
    <section className="page">
      <h1>Transaction history</h1>
      <p className="lede">Local session trail of writes, validation, and finality.</p>
      {history.length === 0 ? (
        <p className="muted">No transactions yet.</p>
      ) : (
        <ul className="tx-list">
          {history.map((tx) => (
            <li key={`${tx.hash}-${tx.at}-${tx.status}`}>
              <strong>{tx.label}</strong>
              <span>{tx.status}</span>
              <code>{tx.hash}</code>
              <time dateTime={tx.at}>{new Date(tx.at).toLocaleString()}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
