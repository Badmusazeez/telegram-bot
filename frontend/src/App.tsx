import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { useFoldPredict } from './hooks/useFoldPredict'
import { HomePage } from './pages/HomePage'
import { PredictionDetailsPage } from './pages/PredictionDetailsPage'
import { PlaceBetPage } from './pages/PlaceBetPage'
import { MyBetsPage } from './pages/MyBetsPage'
import { MarketStatusPage } from './pages/MarketStatusPage'
import { ResolutionResultPage } from './pages/ResolutionResultPage'
import { TransactionHistoryPage } from './pages/TransactionHistoryPage'
import './styles/app.css'

export default function App() {
  const fp = useFoldPredict()

  return (
    <BrowserRouter>
      <Layout
        phase={fp.phase}
        account={fp.account}
        onConnect={() => {
          void fp.connectWallet().catch(() => fp.connectDemoAccount())
        }}
      >
        {fp.error && <p className="error-banner">{fp.error}</p>}
        <Routes>
          <Route
            path="/"
            element={
              <HomePage market={fp.market} statusLabel={fp.statusLabel} phase={fp.phase} />
            }
          />
          <Route path="/prediction" element={<PredictionDetailsPage market={fp.market} />} />
          <Route
            path="/bet"
            element={<PlaceBetPage busy={fp.busy} onBet={fp.placeBet} />}
          />
          <Route
            path="/my-bets"
            element={
              <MyBetsPage
                account={fp.account}
                bet={fp.bet}
                busy={fp.busy}
                onClaim={fp.claim}
              />
            }
          />
          <Route
            path="/status"
            element={
              <MarketStatusPage
                statusLabel={fp.statusLabel}
                phase={fp.phase}
                busy={fp.busy}
                onSettle={fp.settle}
              />
            }
          />
          <Route
            path="/resolution"
            element={<ResolutionResultPage resolution={fp.resolution} />}
          />
          <Route path="/history" element={<TransactionHistoryPage history={fp.history} />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  )
}
