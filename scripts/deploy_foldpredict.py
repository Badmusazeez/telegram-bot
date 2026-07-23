#!/usr/bin/env python3
"""
Deploy FoldPredict to local GLSim/Studio via genlayer-py (no CLI keystore password).

Usage (from project root, with GLSim already running on :4000):

    py scripts\\deploy_foldpredict.py

Writes:
  - artifacts/fold_predict.address
  - frontend/.env  (VITE_* for the UI)
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "contracts" / "fold_predict.py"
ARTIFACTS = ROOT / "artifacts"
FRONTEND_ENV = ROOT / "frontend" / ".env"
RPC_URL = "http://127.0.0.1:4000/api"


def _write_frontend_env(address: str) -> None:
    lines = [
        f"VITE_CONTRACT_ADDRESS={address}",
        "VITE_RPC_URL=http://127.0.0.1:4000/api",
        "VITE_CHAIN=localnet",
    ]
    FRONTEND_ENV.parent.mkdir(parents=True, exist_ok=True)
    # UTF-8 without BOM (Windows Notepad/PowerShell often inject BOM otherwise)
    FRONTEND_ENV.write_text("\n".join(lines) + "\n", encoding="utf-8")
    bad = FRONTEND_ENV.with_suffix(".env.txt")
    if bad.name == ".env.txt" and (FRONTEND_ENV.parent / ".env.txt").exists():
        (FRONTEND_ENV.parent / ".env.txt").unlink()


def main() -> int:
    if not CONTRACT.exists():
        print(f"ERROR: missing contract file: {CONTRACT}", file=sys.stderr)
        return 1

    try:
        from genlayer_py import create_account, create_client
        from genlayer_py.chains import localnet
        from genlayer_py.types import TransactionStatus
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: genlayer-py not installed: {exc}", file=sys.stderr)
        print("Fix: py -m pip install genlayer-py", file=sys.stderr)
        return 1

    code = CONTRACT.read_text(encoding="utf-8")
    account = create_account()
    client = create_client(chain=localnet, endpoint=RPC_URL, account=account)

    print(f"RPC:     {RPC_URL}")
    print(f"Account: {account.address}")
    print(f"Deploying {CONTRACT.relative_to(ROOT)} ...")

    try:
        tx = client.deploy_contract(code=code, args=[])
    except Exception as exc:  # noqa: BLE001
        print(f"ERROR: deploy failed: {exc}", file=sys.stderr)
        print(
            "Make sure GLSim is running: py -m glsim --port 4000 --validators 5",
            file=sys.stderr,
        )
        return 1

    print(f"tx_hash: {tx}")
    receipt = client.wait_for_transaction_receipt(
        transaction_hash=tx,
        status=TransactionStatus.ACCEPTED,
        retries=60,
    )

    address = (
        receipt.get("contract_address")
        or receipt.get("to")
        or receipt.get("recipient")
        or ""
    )
    if not address:
        # Some SDKs nest under data / decoded fields
        for key in ("data", "transaction", "result"):
            nested = receipt.get(key)
            if isinstance(nested, dict):
                address = (
                    nested.get("contract_address")
                    or nested.get("to")
                    or nested.get("recipient")
                    or address
                )
    address = str(address).strip()
    if not address.startswith("0x") or len(address) < 42:
        print("ERROR: could not find contract address in receipt:", file=sys.stderr)
        print(receipt, file=sys.stderr)
        return 1

    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    (ARTIFACTS / "fold_predict.address").write_text(address + "\n", encoding="utf-8")
    _write_frontend_env(address)

    print()
    print(f"Deployed FoldPredict at: {address}")
    print(f"Saved: artifacts/fold_predict.address")
    print(f"Updated: frontend/.env")
    print()
    print("Next:")
    print("  cd frontend")
    print("  npm run dev")
    print("  Open the URL Vite prints, then Ctrl+F5")

    # Quick read smoke
    try:
        info = client.read_contract(
            address=address,
            function_name="get_market_info",
            args=[],
        )
        print(f"Smoke read market_status={getattr(info, 'get', lambda k: None)('market_status') if isinstance(info, dict) else info}")
    except Exception as exc:  # noqa: BLE001
        print(f"(smoke read skipped: {exc})")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
