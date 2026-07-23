"""
Direct-mode unit tests for FoldPredict Intelligent Contract.

Run:
    pytest tests/direct -v
"""

from __future__ import annotations

import json


CONTRACT = "contracts/fold_predict.py"

# Use integer confidence in mocks: direct-mode LLM mock encodes JSON via
# calldata, which cannot carry floats. Contract validation accepts int|float.
YES_RELEASE_PAYLOAD = {
    "released": True,
    "device_name": "iPhone Fold",
    "release_date": "2027-09-15",
    "sources": [
        "https://www.apple.com/newsroom/2027/09/apple-unveils-iphone-fold/",
        "https://www.reuters.com/technology/apple-foldable-iphone-2027",
    ],
    "confidence": 1,
}
NO_RELEASE_PAYLOAD = {
    "released": False,
    "device_name": "",
    "release_date": "",
    "sources": ["https://www.apple.com/newsroom/"],
    "confidence": 1,
}


def _addr_str(addr) -> str:
    if hasattr(addr, "as_hex"):
        return addr.as_hex
    if isinstance(addr, (bytes, bytearray)):
        # Prefer checksummed Address.as_hex once SDK is loaded
        try:
            from genlayer.py.types import Address

            return Address(bytes(addr)).as_hex
        except Exception:
            return "0x" + bytes(addr).hex()
    return str(addr)


def _mock_trusted_web(direct_vm) -> None:
    for host in (
        "apple.com",
        "reuters.com",
        "bloomberg.com",
        "cnbc.com",
        "theverge.com",
        "techcrunch.com",
    ):
        direct_vm.mock_web(
            rf".*{host}.*",
            {
                "status": 200,
                "body": f"Official page content from {host} regarding Apple products.",
            },
        )


def _deploy_market(direct_deploy):
    return direct_deploy(CONTRACT)


def test_market_creation(direct_vm, direct_deploy):
    contract = _deploy_market(direct_deploy)
    info = contract.get_market_info()
    assert (
        info["prediction_statement"]
        == "Will Apple officially release a foldable iPhone before January 1, 2028?"
    )
    assert info["resolution_date"].startswith("2028-01-01")
    assert info["market_status"] == "OPEN"
    assert info["total_yes"] == 0
    assert info["total_no"] == 0
    assert info["settled"] is False
    assert contract.get_market_status() == "Market Open"


def test_bet_yes_and_bet_no(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = _deploy_market(direct_deploy)

    direct_vm.sender = direct_alice
    direct_vm.value = 100
    contract.bet_yes()

    direct_vm.sender = direct_bob
    direct_vm.value = 250
    contract.bet_no()

    totals = contract.get_totals()
    assert totals["total_yes"] == 100
    assert totals["total_no"] == 250
    assert totals["total_pool"] == 350

    alice_bet = contract.get_bet(_addr_str(direct_alice))
    bob_bet = contract.get_bet(_addr_str(direct_bob))
    assert alice_bet["side"] == "YES"
    assert alice_bet["stake"] == 100
    assert bob_bet["side"] == "NO"
    assert bob_bet["stake"] == 250

    participants = contract.get_participants()
    assert _addr_str(direct_alice) in participants
    assert _addr_str(direct_bob) in participants


def test_duplicate_betting_rejected(direct_vm, direct_deploy, direct_alice):
    contract = _deploy_market(direct_deploy)
    direct_vm.sender = direct_alice
    direct_vm.value = 50
    contract.bet_yes()

    with direct_vm.expect_revert("Duplicate betting"):
        direct_vm.value = 10
        contract.bet_no()

    with direct_vm.expect_revert("Duplicate betting"):
        direct_vm.value = 10
        contract.bet_yes()


def test_zero_stake_rejected(direct_vm, direct_deploy, direct_alice):
    contract = _deploy_market(direct_deploy)
    direct_vm.sender = direct_alice
    direct_vm.value = 0
    with direct_vm.expect_revert("Stake must be greater than zero"):
        contract.bet_yes()


def test_deadline_enforcement_blocks_bets(direct_vm, direct_deploy, direct_alice):
    contract = _deploy_market(direct_deploy)
    direct_vm.warp("2028-01-01T00:00:00+00:00")
    direct_vm.sender = direct_alice
    direct_vm.value = 100
    with direct_vm.expect_revert("Betting closed after resolution deadline"):
        contract.bet_yes()


def test_settle_before_deadline_rejected(direct_vm, direct_deploy):
    contract = _deploy_market(direct_deploy)
    direct_vm.warp("2027-12-31T23:59:59+00:00")
    with direct_vm.expect_revert("Resolution deadline has not arrived"):
        contract.settle_market()


def test_payout_calculation_yes_wins(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    """
    Pool = 100 (YES alice) + 300 (NO bob+charlie) = 400
    YES wins => alice payout = (100 / 100) * 400 = 400
    """
    contract = _deploy_market(direct_deploy)

    direct_vm.sender = direct_alice
    direct_vm.value = 100
    contract.bet_yes()

    direct_vm.sender = direct_bob
    direct_vm.value = 200
    contract.bet_no()

    direct_vm.sender = direct_charlie
    direct_vm.value = 100
    contract.bet_no()

    _mock_trusted_web(direct_vm)
    direct_vm.mock_llm(r".*", json.dumps(YES_RELEASE_PAYLOAD))
    direct_vm.warp("2028-01-02T00:00:00+00:00")
    contract.settle_market()

    result = contract.get_resolution_result()
    assert result["settled"] is True
    assert result["outcome"] == "YES"
    assert result["market_status"] == "FINALIZED"

    assert contract.preview_payout(_addr_str(direct_alice)) == 400
    assert contract.preview_payout(_addr_str(direct_bob)) == 0
    assert contract.preview_payout(_addr_str(direct_charlie)) == 0


def test_payout_calculation_no_wins(direct_vm, direct_deploy, direct_alice, direct_bob):
    """
    YES alice=100, NO bob=300, pool=400
    NO wins => bob payout = (300 / 300) * 400 = 400
    """
    contract = _deploy_market(direct_deploy)

    direct_vm.sender = direct_alice
    direct_vm.value = 100
    contract.bet_yes()

    direct_vm.sender = direct_bob
    direct_vm.value = 300
    contract.bet_no()

    _mock_trusted_web(direct_vm)
    direct_vm.mock_llm(r".*", json.dumps(NO_RELEASE_PAYLOAD))
    direct_vm.warp("2028-01-02T00:00:00+00:00")
    contract.settle_market()

    assert contract.get_resolution_result()["outcome"] == "NO"
    assert contract.preview_payout(_addr_str(direct_bob)) == 400
    assert contract.preview_payout(_addr_str(direct_alice)) == 0


def test_proportional_payout_among_multiple_winners(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    """
    YES: alice=100, bob=300; NO: charlie=100; pool=500
    YES wins:
      alice = (100/400)*500 = 125
      bob   = (300/400)*500 = 375
    """
    contract = _deploy_market(direct_deploy)

    direct_vm.sender = direct_alice
    direct_vm.value = 100
    contract.bet_yes()

    direct_vm.sender = direct_bob
    direct_vm.value = 300
    contract.bet_yes()

    direct_vm.sender = direct_charlie
    direct_vm.value = 100
    contract.bet_no()

    _mock_trusted_web(direct_vm)
    direct_vm.mock_llm(r".*", json.dumps(YES_RELEASE_PAYLOAD))
    direct_vm.warp("2028-01-05T12:00:00+00:00")
    contract.settle_market()

    assert contract.preview_payout(_addr_str(direct_alice)) == 125
    assert contract.preview_payout(_addr_str(direct_bob)) == 375
    assert contract.preview_payout(_addr_str(direct_charlie)) == 0


def test_mocked_web_and_llm_settlement_path(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = _deploy_market(direct_deploy)
    direct_vm.sender = direct_alice
    direct_vm.value = 10
    contract.bet_yes()
    direct_vm.sender = direct_bob
    direct_vm.value = 10
    contract.bet_no()

    _mock_trusted_web(direct_vm)
    direct_vm.mock_llm(r".*foldable iPhone.*", json.dumps(YES_RELEASE_PAYLOAD))
    direct_vm.warp("2028-06-01T00:00:00+00:00")
    contract.settle_market()

    resolution = contract.get_resolution_result()
    assert resolution["outcome"] == "YES"
    assert "iPhone Fold" in resolution["device_name"]
    sources = json.loads(resolution["sources"])
    assert any("apple.com/newsroom" in s for s in sources)


def test_rumor_only_evidence_resolves_no(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = _deploy_market(direct_deploy)
    direct_vm.sender = direct_alice
    direct_vm.value = 10
    contract.bet_yes()
    direct_vm.sender = direct_bob
    direct_vm.value = 10
    contract.bet_no()

    weak_payload = {
        "released": True,
        "device_name": "Concept Fold",
        "release_date": "2027-01-01",
        "sources": ["https://www.theverge.com/rumor-only"],
        "confidence": 0,
    }
    _mock_trusted_web(direct_vm)
    direct_vm.mock_llm(r".*", json.dumps(weak_payload))
    direct_vm.warp("2028-01-02T00:00:00+00:00")
    contract.settle_market()

    # Single non-newsroom source + low confidence => official evidence not confirmed => NO
    assert contract.get_resolution_result()["outcome"] == "NO"


def test_claim_reward_and_duplicate_claim(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = _deploy_market(direct_deploy)
    direct_vm.sender = direct_alice
    direct_vm.value = 100
    contract.bet_yes()
    direct_vm.sender = direct_bob
    direct_vm.value = 100
    contract.bet_no()

    _mock_trusted_web(direct_vm)
    direct_vm.mock_llm(r".*", json.dumps(NO_RELEASE_PAYLOAD))
    direct_vm.warp("2028-01-02T00:00:00+00:00")
    contract.settle_market()

    # Ensure contract has balance for payout emission in direct mode
    contract_addr = getattr(contract, "address", None)
    if contract_addr is not None:
        direct_vm.deal(contract_addr, 10**18)

    direct_vm.sender = direct_bob
    direct_vm.value = 0
    contract.claim_reward()
    bob_bet = contract.get_bet(_addr_str(direct_bob))
    assert bob_bet["claimed"] is True

    with direct_vm.expect_revert("Reward already claimed"):
        contract.claim_reward()

    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("No winnings to claim"):
        contract.claim_reward()


def test_malformed_llm_json_classified(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = _deploy_market(direct_deploy)
    direct_vm.sender = direct_alice
    direct_vm.value = 5
    contract.bet_yes()
    direct_vm.sender = direct_bob
    direct_vm.value = 5
    contract.bet_no()

    _mock_trusted_web(direct_vm)
    direct_vm.mock_llm(r".*", "not-json{{{")
    direct_vm.warp("2028-01-02T00:00:00+00:00")

    with direct_vm.expect_revert("LLM_ERROR"):
        contract.settle_market()
