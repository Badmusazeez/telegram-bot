#!/usr/bin/env bash
# Build and deploy my-first-thru-program to Thru alphanet.
set -euo pipefail

PROJECT_DIR="${1:-thru-projects/my-first-thru-program}"
SEED="${2:-my-first-thru-program-$(date +%s | tail -c 6)}"
BIN="build/thruvm/bin/my_first_thru_program_c.bin"

export PATH="${HOME}/.thru/sdk/toolchain/bin:${PATH}"
export RISCV_TOOLCHAIN_ROOT="${HOME}/.thru/sdk/toolchain"
export RISCV_SYSROOT="${HOME}/.thru/sdk/toolchain/picolibc/thruvm"

if ! command -v thru >/dev/null 2>&1; then
  echo "thru CLI not found. Run scripts/setup-thru.sh first." >&2
  exit 1
fi

thru --json faucet withdraw default 10000 || true

cd "${PROJECT_DIR}"
make -j

echo "Deploying with seed: ${SEED}"
thru --json program create "${SEED}" "${BIN}" | tee /tmp/thru-program-create.json

echo
echo "Status:"
thru --json program status "${SEED}"
echo
echo "Explorer: https://scan.thru.org"
echo "Seed saved above — keep it to derive/upgrade this program later."
