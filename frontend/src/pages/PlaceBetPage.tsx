import { useState, type FormEvent } from 'react'

export function PlaceBetPage({
  busy,
  onBet,
}: {
  busy: boolean
  onBet: (side: 'YES' | 'NO', amountWei: bigint) => Promise<unknown>
}) {
  const [side, setSide] = useState<'YES' | 'NO'>('YES')
  const [amount, setAmount] = useState('1')
  const [note, setNote] = useState<string | null>(null)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setNote(null)
    const gen = Number(amount)
    if (!Number.isFinite(gen) || gen <= 0) {
      setNote('Enter a positive GEN amount')
      return
    }
    const wei = BigInt(Math.round(gen * 1e18))
    await onBet(side, wei)
    setNote(`Bet Submitted — ${side} for ${gen} GEN`)
  }

  return (
    <section className="page">
      <h1>Place bet</h1>
      <p className="lede">
        Funds lock in the Intelligent Contract until settlement. Duplicate bets from the same
        address are rejected.
      </p>
      <form className="bet-form" onSubmit={onSubmit}>
        <fieldset>
          <legend>Side</legend>
          <label>
            <input
              type="radio"
              name="side"
              checked={side === 'YES'}
              onChange={() => setSide('YES')}
            />
            YES — Apple releases an official foldable iPhone
          </label>
          <label>
            <input
              type="radio"
              name="side"
              checked={side === 'NO'}
              onChange={() => setSide('NO')}
            />
            NO — No official release before the deadline
          </label>
        </fieldset>
        <label className="stack">
          Stake (GEN)
          <input
            type="number"
            min="0"
            step="0.0001"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Submitting…' : 'Lock stake'}
        </button>
      </form>
      {note && <p className="flash">{note}</p>}
    </section>
  )
}
