#!/usr/bin/env bash
# Deploy FoldPredict and smoke-verify with genlayer CLI + genlayer-py.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACT="${ROOT_DIR}/contracts/fold_predict.py"
RPC_URL="${GENLAYER_RPC_URL:-http://127.0.0.1:4000/api}"
ARTIFACTS_DIR="${ROOT_DIR}/artifacts"
mkdir -p "${ARTIFACTS_DIR}"

echo "==> Linting contract"
genvm-lint check "${CONTRACT}" --json

echo "==> Deploying ${CONTRACT}"
DEPLOY_OUT="$(genlayer deploy --contract "${CONTRACT}" --rpc "${RPC_URL}" | tee /dev/stderr)"
ADDRESS="$(echo "${DEPLOY_OUT}" | grep -Eo '0x[a-fA-F0-9]{40}' | tail -n1 || true)"

if [[ -z "${ADDRESS}" ]]; then
  echo "Failed to parse deployed contract address from deploy output" >&2
  exit 1
fi

echo "${ADDRESS}" > "${ARTIFACTS_DIR}/fold_predict.address"
echo "FOLDPREDICT_CONTRACT_ADDRESS=${ADDRESS}" > "${ROOT_DIR}/.env.deploy"
echo "Deployed FoldPredict at ${ADDRESS}"

echo "==> Schema"
genlayer schema "${ADDRESS}" --rpc "${RPC_URL}" | tee "${ARTIFACTS_DIR}/fold_predict.schema.json"

echo "==> Call get_market_info"
genlayer call "${ADDRESS}" get_market_info --rpc "${RPC_URL}" | tee "${ARTIFACTS_DIR}/fold_predict.call.json"

echo "==> Call get_market_status"
genlayer call "${ADDRESS}" get_market_status --rpc "${RPC_URL}"

echo "==> Write smoke (bet_yes via genlayer-py)"
"${ROOT_DIR}/scripts/place_bet.sh" "${ADDRESS}" YES 1000000000000000000 | tee "${ARTIFACTS_DIR}/fold_predict.write.log"

echo "Deployment verification complete."
echo "Address saved to artifacts/fold_predict.address"
