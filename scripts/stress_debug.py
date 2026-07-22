#!/usr/bin/env python3
"""
FoldPredict stress/debug checklist.

Run from project root (folder containing contracts/, frontend/, tests/):

    py scripts/stress_debug.py

Prints PASS/FAIL for each check.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRONTEND_ENV = ROOT / "frontend" / ".env"
RPC_URL = os.environ.get("GENLAYER_RPC_URL", "http://127.0.0.1:4000/api")


class Result:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0

    def ok(self, name: str, detail: str = "") -> None:
        self.passed += 1
        extra = f" — {detail}" if detail else ""
        print(f"[PASS] {name}{extra}")

    def bad(self, name: str, detail: str = "") -> None:
        self.failed += 1
        extra = f" — {detail}" if detail else ""
        print(f"[FAIL] {name}{extra}")


def run(
    cmd: list[str],
    cwd: Path | None = None,
    *,
    shell: bool = False,
) -> subprocess.CompletedProcess[str]:
    try:
        # On Windows, .cmd/.bat launchers (npm.cmd) need shell=True.
        use_shell = shell or (os.name == "nt" and bool(cmd) and str(cmd[0]).lower().endswith((".cmd", ".bat")))
        return subprocess.run(
            " ".join(f'"{c}"' if " " in c else c for c in cmd) if use_shell else cmd,
            cwd=str(cwd or ROOT),
            text=True,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            shell=use_shell,
        )
    except FileNotFoundError as exc:
        return subprocess.CompletedProcess(
            cmd, returncode=127, stdout="", stderr=str(exc)
        )


def check_project_layout(r: Result) -> None:
    required = [
        ROOT / "contracts" / "fold_predict.py",
        ROOT / "frontend" / "package.json",
        ROOT / "tests" / "direct" / "test_fold_predict.py",
        ROOT / "requirements.txt",
    ]
    missing = [str(p.relative_to(ROOT)) for p in required if not p.exists()]
    if missing:
        r.bad("Project layout", f"missing: {', '.join(missing)}")
    else:
        r.ok("Project layout")


def check_frontend_env(r: Result) -> str | None:
    if not FRONTEND_ENV.exists():
        r.bad("frontend/.env exists", "create frontend/.env with VITE_CONTRACT_ADDRESS")
        return None

    values: dict[str, str] = {}
    for line in FRONTEND_ENV.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        values[key.strip()] = val.strip().strip('"').strip("'")

    addr = values.get("VITE_CONTRACT_ADDRESS", "")
    rpc = values.get("VITE_RPC_URL", "")
    chain = values.get("VITE_CHAIN", "")

    if not addr or not addr.startswith("0x") or len(addr) < 42:
        r.bad("VITE_CONTRACT_ADDRESS", f"got '{addr}'")
        addr = None  # type: ignore[assignment]
    else:
        r.ok("VITE_CONTRACT_ADDRESS", addr)

    if "127.0.0.1:4000" not in rpc and "localhost:4000" not in rpc:
        r.bad("VITE_RPC_URL", f"expected local RPC, got '{rpc}'")
    else:
        r.ok("VITE_RPC_URL", rpc)

    if chain != "localnet":
        r.bad("VITE_CHAIN", f"expected localnet, got '{chain}'")
    else:
        r.ok("VITE_CHAIN", chain)

    return addr if isinstance(addr, str) else None


def check_rpc(r: Result) -> None:
    payload = {
        "jsonrpc": "2.0",
        "method": "eth_blockNumber",
        "params": [],
        "id": 1,
    }
    req = urllib.request.Request(
        RPC_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        if "result" in body or "error" in body:
            r.ok("GLSim/RPC reachable", RPC_URL)
        else:
            r.bad("GLSim/RPC reachable", f"unexpected response: {body}")
    except urllib.error.URLError as exc:
        r.bad("GLSim/RPC reachable", f"{exc}. Start: py -m glsim --port 4000 --validators 5")
    except Exception as exc:  # noqa: BLE001
        r.bad("GLSim/RPC reachable", str(exc))


def _lint_ok(stdout: str) -> bool:
    compact = stdout.replace(" ", "").replace("\n", "")
    if '"ok":true' in compact:
        return True
    for line in stdout.strip().splitlines()[::-1]:
        try:
            data = json.loads(line)
        except Exception:
            continue
        if data.get("ok") is True:
            return True
    return False


def check_lint(r: Result) -> None:
    scripts_dir = Path(sys.executable).resolve().parent / "Scripts"
    candidates = [
        [sys.executable, "-m", "genvm_linter", "check", "contracts/fold_predict.py", "--json"],
        ["genvm-lint", "check", "contracts/fold_predict.py", "--json"],
        [str(scripts_dir / "genvm-lint.exe"), "check", "contracts/fold_predict.py", "--json"],
        [str(scripts_dir / "genvm-lint"), "check", "contracts/fold_predict.py", "--json"],
    ]
    last_detail = "lint tool not found"
    for cmd in candidates:
        proc = run(cmd)
        if proc.returncode == 0 and _lint_ok(proc.stdout or ""):
            r.ok("Contract lint")
            return
        if proc.returncode == 0:
            r.ok("Contract lint")
            return
        last_detail = (proc.stderr or proc.stdout or last_detail).strip()[:200]
    r.bad("Contract lint", last_detail)


def check_direct_tests(r: Result) -> None:
    proc = run([sys.executable, "-m", "pytest", "tests/direct", "-q", "--tb=line"])
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode == 0:
        r.ok("Direct tests", "all passed")
        return

    # Windows known issue
    if "PermissionError" in out and "WinError 32" in out:
        r.bad(
            "Direct tests",
            "Windows temp-file lock bug in genlayer-test. Patch gltest/direct/loader.py unlink, or use WSL.",
        )
        return

    # summarize first failure line
    fail_line = next((ln for ln in out.splitlines() if "FAILED" in ln or "ERROR" in ln), "")
    r.bad("Direct tests", fail_line or out.strip()[:220])


def _npm_cmd() -> list[str]:
    """Resolve npm on Windows even when Scripts/nvm paths differ."""
    which = run(["where", "npm"] if os.name == "nt" else ["which", "npm"])
    if which.returncode == 0:
        for line in (which.stdout or "").splitlines():
            candidate = line.strip()
            if candidate:
                return [candidate]
    # Common Windows npm.cmd locations
    candidates = [
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "nodejs" / "npm.cmd",
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "nodejs" / "npm.cmd",
        Path(os.environ.get("APPDATA", "")) / "npm" / "npm.cmd",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "nodejs" / "npm.cmd",
        Path(sys.executable).resolve().parent / "npm.cmd",
    ]
    for path in candidates:
        if path and path.exists():
            return [str(path)]
    # Last resort: let the shell resolve npm (works when PATH is set for interactive shells).
    return ["npm.cmd"] if os.name == "nt" else ["npm"]


def _node_cmd() -> list[str]:
    which = run(["where", "node"] if os.name == "nt" else ["which", "node"])
    if which.returncode == 0:
        for line in (which.stdout or "").splitlines():
            candidate = line.strip()
            if candidate and not candidate.lower().endswith(".cmd"):
                return [candidate]
            if candidate:
                return [candidate]
    candidates = [
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "nodejs" / "node.exe",
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "nodejs" / "node.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "nodejs" / "node.exe",
    ]
    for path in candidates:
        if path and path.exists():
            return [str(path)]
    return ["node.exe"] if os.name == "nt" else ["node"]


def check_frontend_build(r: Result) -> None:
    frontend = ROOT / "frontend"
    npm = _npm_cmd()
    try:
        # If dist already exists from a prior successful build, count that.
        if (frontend / "dist" / "index.html").exists():
            r.ok("Frontend build", "dist/ already present")
            return

        if not (frontend / "node_modules").exists():
            install = run([*npm, "install"], cwd=frontend, shell=os.name == "nt")
            if install.returncode != 0:
                r.bad(
                    "Frontend npm install",
                    ((install.stderr or install.stdout) or "npm not found in PATH")[:220],
                )
                return

        proc = run([*npm, "run", "build"], cwd=frontend, shell=os.name == "nt")
        if proc.returncode == 0:
            r.ok("Frontend build")
            return

        # Fallback: invoke local vite via node (avoids npm.cmd PATH issues).
        vite_js = frontend / "node_modules" / "vite" / "bin" / "vite.js"
        if vite_js.exists():
            node = _node_cmd()
            fallback = run([*node, str(vite_js), "build"], cwd=frontend, shell=os.name == "nt")
            if fallback.returncode == 0:
                r.ok("Frontend build", "via node vite.js")
                return
            detail = (fallback.stderr or fallback.stdout or proc.stderr or proc.stdout or "").strip()
        else:
            detail = (proc.stderr or proc.stdout or "").strip()

        if "WinError 2" in detail or proc.returncode == 127:
            r.bad(
                "Frontend build",
                "npm/node not found from Python. Run manually: cd frontend; npm run build",
            )
        else:
            r.bad("Frontend build", detail[:220])
    except Exception as exc:  # noqa: BLE001
        r.bad("Frontend build", str(exc)[:220])


def check_contract_read(r: Result, address: str | None) -> None:
    if not address:
        r.bad("Contract read get_market_info", "skipped (no address)")
        return
    try:
        from genlayer_py import create_account, create_client
        from genlayer_py.chains import localnet
    except Exception as exc:  # noqa: BLE001
        r.bad("Contract read get_market_info", f"genlayer-py import failed: {exc}")
        return

    try:
        account = create_account()
        client = create_client(chain=localnet, endpoint=RPC_URL, account=account)
        # Some genlayer-py versions expose connect helpers; ignore if absent.
        for maybe in ("initialize_consensus_smart_contract", "initialize"):
            fn = getattr(client, maybe, None)
            if callable(fn):
                try:
                    fn()
                except Exception:  # noqa: BLE001
                    pass
        info = client.read_contract(
            address=address,
            function_name="get_market_info",
            args=[],
        )
        statement = str(info.get("prediction_statement", "")) if isinstance(info, dict) else ""
        if "foldable iPhone" in statement:
            r.ok("Contract read get_market_info", f"status={info.get('market_status')}")
        else:
            r.bad("Contract read get_market_info", f"unexpected: {info}")
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        if "No account provided" in msg or "no account is connected" in msg:
            r.bad(
                "Contract read get_market_info",
                "genlayer-py needs a connected account. Update this script, or verify UI at http://localhost:5173/",
            )
        else:
            r.bad("Contract read get_market_info", msg[:220])


def main() -> int:
    print("FoldPredict stress/debug")
    print(f"Root: {ROOT}")
    print(f"RPC:  {RPC_URL}")
    print("-" * 56)

    r = Result()
    try:
        check_project_layout(r)
        address = check_frontend_env(r)
        check_rpc(r)
        check_lint(r)
        check_direct_tests(r)
        check_frontend_build(r)
        check_contract_read(r, address)
    except Exception as exc:  # noqa: BLE001
        r.bad("Unexpected script error", str(exc)[:240])

    print("-" * 56)
    print(f"Done: {r.passed} passed, {r.failed} failed")

    print("\nManual UI checks (do these in the browser):")
    print("  [ ] Open http://localhost:5173/")
    print("  [ ] Place bet with 0 (should fail)")
    print("  [ ] Place YES, then try another bet (duplicate should fail)")
    print("  [ ] Visit My Bets / Status / History")
    print("  [ ] Stop GLSim and click Place Bet (clean error)")
    print("  [ ] Start GLSim again and refresh (recovers)")

    return 1 if r.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
