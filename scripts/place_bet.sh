#!/usr/bin/env bash
# Place a bet using genlayer-py (CLI write has no native --value in this version).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC_URL="${GENLAYER_RPC_URL:-http://127.0.0.1:4000/api}"
ADDRESS="${1:-}"
SIDE="${2:-YES}"
VALUE="${3:-1000000000000000000}"

if [[ -z "${ADDRESS}" && -f "${ROOT_DIR}/artifacts/fold_predict.address" ]]; then
  ADDRESS="$(cat "${ROOT_DIR}/artifacts/fold_predict.address")"
fi

if [[ -z "${ADDRESS}" ]]; then
  echo "Usage: $0 <contract_address> [YES|NO] [value_wei]" >&2
  exit 1
fi

METHOD="bet_yes"
if [[ "${SIDE^^}" == "NO" ]]; then
  METHOD="bet_no"
fi

python3 - <<PY
from genlayer_py import create_client, create_account
from genlayer_py.chains import localnet
from genlayer_py.types import TransactionStatus

address = "${ADDRESS}"
method = "${METHOD}"
value = int("${VALUE}")
rpc = "${RPC_URL}"

account = create_account()
client = create_client(chain=localnet, endpoint=rpc, account=account)
print(f"account={account.address}")
print(f"balance={client.get_balance(account.address)}")

tx = client.write_contract(address=address, function_name=method, args=[], value=value)
print(f"tx_hash={tx}")
receipt = client.wait_for_transaction_receipt(
    transaction_hash=tx,
    status=TransactionStatus.ACCEPTED,
    retries=40,
)
status = receipt.get("status_name") or receipt.get("status")
print(f"status={status}")
print(receipt)
PY
