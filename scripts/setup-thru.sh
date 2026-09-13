#!/usr/bin/env bash
# Setup Thru CLI, toolchain, and C SDK (Thru alphanet).
# Based on: https://github.com/mztacat/Getting-started-with-Thru-Create-onchain-account
set -euo pipefail

THRU_VERSION="${THRU_VERSION:-0.2.38}"
THRU_HOME="${HOME}/.thru"
SDK_TOOLCHAIN="${THRU_HOME}/sdk/toolchain"
SDK_C="${THRU_HOME}/sdk/c"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

echo "==> Installing Thru CLI v${THRU_VERSION}"
npm install -g "thru@${THRU_VERSION}"
hash -r
thru --version

echo "==> Health check (creates ~/.thru/cli/config.yaml on first run)"
thru --json getversion

echo "==> Ensuring on-chain account 'default' exists"
if ! thru --json getaccountinfo default >/dev/null 2>&1; then
  thru --json account create default
fi

PUBKEY=$(thru --json account create default 2>/dev/null | jq -r '.account_create.public_key // empty' || true)
if [[ -z "${PUBKEY}" ]]; then
  # Account already exists; resolve via balance helper response after faucet
  thru --json faucet withdraw default 1000 >/dev/null || true
  PUBKEY=$(thru --json getbalance default | jq -r '.balance.pubkey')
fi
echo "Public key: ${PUBKEY}"

echo "==> Funding from faucet"
thru --json faucet withdraw default 10000 || true

mkdir -p "${SDK_TOOLCHAIN}" "${SDK_C}"

if [[ ! -x "${SDK_TOOLCHAIN}/bin/riscv64-unknown-elf-gcc" ]]; then
  echo "==> Downloading RISC-V toolchain (~1.1GB)"
  TMP=$(mktemp -d)
  curl -L --http1.1 --retry 5 --retry-delay 5 --retry-all-errors --max-time 900 \
    -o "${TMP}/toolchain.tar.gz" \
    "https://github.com/Unto-Labs/thru/releases/download/v${THRU_VERSION}/thru-toolchain-Linux-x86_64-v${THRU_VERSION}.tar.gz"
  tar xz -f "${TMP}/toolchain.tar.gz" -C "${SDK_TOOLCHAIN}" --strip-components=1
  rm -rf "${TMP}"
fi

if [[ ! -f "${SDK_C}/thru-sdk/thru_c_program.mk" ]]; then
  echo "==> Downloading C SDK"
  TMP=$(mktemp -d)
  curl -L --retry 5 --retry-delay 5 --max-time 300 \
    -o "${TMP}/sdk-c.tar.gz" \
    "https://github.com/Unto-Labs/thru/releases/download/v${THRU_VERSION}/thru-program-sdk-c-v${THRU_VERSION}.tar.gz"
  tar xz -f "${TMP}/sdk-c.tar.gz" -C "${SDK_C}" --strip-components=1
  rm -rf "${TMP}"
fi

export PATH="${SDK_TOOLCHAIN}/bin:${PATH}"
export RISCV_TOOLCHAIN_ROOT="${SDK_TOOLCHAIN}"
export RISCV_SYSROOT="${SDK_TOOLCHAIN}/picolibc/thruvm"

echo "==> Preparing C SDK include/lib layout"
mkdir -p "${SDK_C}/thru-sdk/include/thru-sdk"
ln -sfn ../../c "${SDK_C}/thru-sdk/include/thru-sdk/c"
(
  cd "${SDK_C}"
  make BASEDIR="${SDK_C}/" BUILDDIR="thru-sdk" all lib include
)

echo "==> Setup complete"
echo "    CLI:       $(thru --version)"
echo "    Pubkey:    ${PUBKEY}"
echo "    Toolchain: ${SDK_TOOLCHAIN}"
echo "    C SDK:     ${SDK_C}"
echo
echo "Next:"
echo "  mkdir -p thru-projects && thru dev init c my-first-thru-program --path thru-projects"
echo "  cd thru-projects/my-first-thru-program && make -j"
echo "  thru --json program create <seed> build/thruvm/bin/my_first_thru_program_c.bin"
