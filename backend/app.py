"""
FoldPredict backend helpers using the official genlayer-py SDK.

Provides read/write helpers and a small FastAPI surface for the React frontend
when direct browser RPC is unavailable. All methods are verified against
genlayer-py's GenLayerClient API (create_client, read_contract, write_contract,
wait_for_transaction_receipt, get_contract_schema).
"""

from __future__ import annotations

import os
from typing import Any, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from genlayer_py import create_client, create_account
from genlayer_py.chains import localnet, studionet, testnet_bradbury

load_dotenv()

CHAINS = {
    "localnet": localnet,
    "studionet": studionet,
    "testnet_bradbury": testnet_bradbury,
}

DEFAULT_RPC = os.getenv("GENLAYER_RPC_URL", "http://127.0.0.1:4000/api")
DEFAULT_CHAIN = os.getenv("GENLAYER_CHAIN", "localnet")
CONTRACT_ADDRESS = os.getenv("FOLDPREDICT_CONTRACT_ADDRESS", "")
PRIVATE_KEY = os.getenv("GENLAYER_PRIVATE_KEY", "")


def _resolve_chain(name: str):
    if name not in CHAINS:
        raise ValueError(f"Unknown chain '{name}'. Valid: {', '.join(CHAINS)}")
    return CHAINS[name]


def build_client(
    *,
    chain_name: str = DEFAULT_CHAIN,
    rpc_url: Optional[str] = None,
    private_key: Optional[str] = None,
):
    chain = _resolve_chain(chain_name)
    account = None
    key = private_key or PRIVATE_KEY
    if key:
        account = create_account(key)
    return create_client(
        chain=chain,
        endpoint=rpc_url or DEFAULT_RPC,
        account=account,
    )


class BetRequest(BaseModel):
    side: str = Field(description="YES or NO")
    amount_wei: int = Field(gt=0, description="Stake in wei")
    private_key: Optional[str] = None


class SettleRequest(BaseModel):
    private_key: Optional[str] = None


class ClaimRequest(BaseModel):
    private_key: Optional[str] = None


app = FastAPI(
    title="FoldPredict API",
    description="Backend helpers for the FoldPredict GenLayer prediction market",
    version="1.0.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _require_contract() -> str:
    if not CONTRACT_ADDRESS:
        raise HTTPException(
            status_code=500,
            detail="FOLDPREDICT_CONTRACT_ADDRESS is not configured",
        )
    return CONTRACT_ADDRESS


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "chain": DEFAULT_CHAIN}


@app.get("/market")
def get_market() -> Any:
    client = build_client()
    address = _require_contract()
    return client.read_contract(
        address=address,
        function_name="get_market_info",
        args=[],
    )


@app.get("/market/status")
def get_status() -> Any:
    client = build_client()
    address = _require_contract()
    return {
        "status": client.read_contract(
            address=address,
            function_name="get_market_status",
            args=[],
        )
    }


@app.get("/market/resolution")
def get_resolution() -> Any:
    client = build_client()
    address = _require_contract()
    return client.read_contract(
        address=address,
        function_name="get_resolution_result",
        args=[],
    )


@app.get("/bets/{user_address}")
def get_bet(user_address: str) -> Any:
    client = build_client()
    address = _require_contract()
    return client.read_contract(
        address=address,
        function_name="get_bet",
        args=[user_address],
    )


@app.get("/schema")
def get_schema() -> Any:
    client = build_client()
    address = _require_contract()
    return client.get_contract_schema(address)


@app.post("/bets")
def place_bet(body: BetRequest) -> Any:
    side = body.side.strip().upper()
    if side not in ("YES", "NO"):
        raise HTTPException(status_code=400, detail="side must be YES or NO")

    client = build_client(private_key=body.private_key)
    if client.account is None:
        raise HTTPException(status_code=400, detail="private key required to place bets")

    address = _require_contract()
    function_name = "bet_yes" if side == "YES" else "bet_no"
    tx_hash = client.write_contract(
        address=address,
        function_name=function_name,
        args=[],
        value=body.amount_wei,
    )
    receipt = client.wait_for_transaction_receipt(transaction_hash=tx_hash)
    return {"tx_hash": tx_hash, "receipt": receipt}


@app.post("/settle")
def settle(body: SettleRequest) -> Any:
    client = build_client(private_key=body.private_key)
    if client.account is None:
        raise HTTPException(status_code=400, detail="private key required to settle")
    address = _require_contract()
    tx_hash = client.write_contract(
        address=address,
        function_name="settle_market",
        args=[],
        value=0,
    )
    receipt = client.wait_for_transaction_receipt(transaction_hash=tx_hash)
    return {"tx_hash": tx_hash, "receipt": receipt}


@app.post("/claim")
def claim(body: ClaimRequest) -> Any:
    client = build_client(private_key=body.private_key)
    if client.account is None:
        raise HTTPException(status_code=400, detail="private key required to claim")
    address = _require_contract()
    tx_hash = client.write_contract(
        address=address,
        function_name="claim_reward",
        args=[],
        value=0,
    )
    receipt = client.wait_for_transaction_receipt(transaction_hash=tx_hash)
    return {"tx_hash": tx_hash, "receipt": receipt}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host=os.getenv("BACKEND_HOST", "0.0.0.0"),
        port=int(os.getenv("BACKEND_PORT", "8000")),
        reload=True,
    )
