# FoldPredict

Decentralized prediction market on [GenLayer](https://docs.genlayer.com) for:

> Will Apple officially release a foldable iPhone before January 1, 2028?

Settlement is performed by GenLayer validators that independently search trusted public sources (Apple Newsroom, Apple.com, Apple Events, Reuters, Bloomberg, CNBC, The Verge, TechCrunch), apply LLM reasoning, reach equivalence consensus, and distribute winnings on-chain — without a centralized oracle.

## Structure

```
FoldPredict/
├── contracts/fold_predict.py
├── frontend/          # React + TypeScript + genlayer-js
├── backend/app.py     # FastAPI helpers via genlayer-py
├── tests/direct/      # pytest in-memory unit tests
├── tests/integration/ # gltest Studio / localnet tests
├── scripts/           # deploy + bet helpers
├── gltest.config.yaml
└── requirements.txt
```

## Prerequisites

- Python 3.12+
- Node.js 18+
- GenLayer CLI (`npm install -g genlayer` or local prefix install)
- Optional: Docker for local Studio (`genlayer init && genlayer up`)

```bash
pip install -r requirements.txt
cd frontend && npm install
```

## Intelligent Contract

`contracts/fold_predict.py` is a GenLayer Intelligent Contract that:

- Creates the market with the prediction statement and `2028-01-01` deadline
- Accepts payable `bet_yes` / `bet_no` stakes (one bet per address)
- Locks funds and blocks betting after the deadline
- Tracks participants in `DynArray` / stakes in `TreeMap`
- Settles via `gl.vm.run_nondet_unsafe` with separate leader and validator logic
- Resolves **YES** only when Apple Newsroom confirms **or** multiple trusted sources confirm an official release before the deadline
- Otherwise resolves **NO** (rumors/patents/leaks ignored)
- Pays winners: `(user_stake / total_winning_stake) * total_pool`

### Lint

```bash
genvm-lint check contracts/fold_predict.py --json
```

## Testing

### Direct (unit)

```bash
pytest tests/direct -v
```

Covers market creation, betting, duplicate bets, deadline enforcement, payout math, mocked web/LLM responses, and malformed JSON classification (`[LLM_ERROR]`).

### Integration

Requires a running GenLayer endpoint (GLSim, localnet, or studionet):

```bash
# GLSim (fast)
glsim --port 4000 --validators 5 &

# or Studio localnet
genlayer up

gltest tests/integration -v -s
gltest tests/integration -v -s --network localnet
```

Integration coverage includes deployment, betting txs, mocked validator consensus with `transaction_context` (`validators` + `genvm_datetime`), and payout preview after settlement.

## Deployment

```bash
chmod +x scripts/*.sh
# Ensure an RPC is up (GLSim or Studio):
#   glsim --port 4000 --validators 5
#   # or: genlayer up
./scripts/deploy.sh
```

This runs lint, `genlayer deploy`, then verifies with `genlayer schema` and `genlayer call`. Payable smoke writes use `scripts/place_bet.sh` (genlayer-py) because the current CLI `write` command has no `--value` flag.

Debug failed txs with:

```bash
genlayer receipt <txHash>
```

**Note:** GLSim is excellent for deploy/call smoke tests but has known gaps versus full GenVM/Studio (payable `value` forwarding and some deploy paths). Prefer `genlayer up` (Studio localnet) or studionet for end-to-end settlement and payout verification. Direct-mode tests already cover betting, deadlines, mocked web/LLM adjudication, and payout math.

## Backend

```bash
export FOLDPREDICT_CONTRACT_ADDRESS=0x...
export GENLAYER_RPC_URL=http://127.0.0.1:4000/api
uvicorn backend.app:app --reload --port 8000
```

Endpoints wrap documented `genlayer-py` methods only: `read_contract`, `write_contract`, `wait_for_transaction_receipt`, `get_contract_schema`.

## Frontend

```bash
cd frontend
cp .env.example .env
# set VITE_CONTRACT_ADDRESS and VITE_RPC_URL
npm run dev
```

Pages: Home, Prediction Details, Place Bet, My Bets, Market Status, Resolution Result, Transaction History.

Status phases surfaced in the UI:

Market Open → Bet Submitted → Pending Validation → Validator Consensus → Finalized → Claim Reward

Built with official `genlayer-js` APIs: `createClient`, `createAccount`, `readContract`, `writeContract`, `waitForTransactionReceipt`, `TransactionStatus`, `ExecutionResult`.

## Equivalence rules (non-strict)

Validators agree when the binary outcome matches after independent web+LLM evaluation. YES requires official evidence:

1. Apple Newsroom confirmation, **or**
2. At least two trusted sources confirming an official product release before 2028-01-01

Failures are classified with deterministic prefixes: `[EXPECTED]`, `[EXTERNAL]`, `[TRANSIENT]`, `[LLM_ERROR]`.
