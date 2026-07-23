# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from genlayer import *

import json
import typing
from datetime import datetime, timezone

# Deterministic failure classification prefixes (GenLayer best practice)
ERROR_EXPECTED = "[EXPECTED]"
ERROR_EXTERNAL = "[EXTERNAL]"
ERROR_TRANSIENT = "[TRANSIENT]"
ERROR_LLM = "[LLM_ERROR]"

PREDICTION_STATEMENT = (
    "Will Apple officially release a foldable iPhone before January 1, 2028?"
)
RESOLUTION_DEADLINE_ISO = "2028-01-01T00:00:00+00:00"
RESOLUTION_DEADLINE = datetime(2028, 1, 1, 0, 0, 0, tzinfo=timezone.utc)

# Trusted public sources for official product-release evidence
TRUSTED_SOURCES: list[str] = [
    "https://www.apple.com/newsroom/",
    "https://www.apple.com/",
    "https://www.apple.com/apple-events/",
    "https://www.reuters.com/",
    "https://www.bloomberg.com/",
    "https://www.cnbc.com/",
    "https://www.theverge.com/",
    "https://techcrunch.com/",
]

APPLE_NEWSROOM = "https://www.apple.com/newsroom/"

MIN_CONFIDENCE = 0.75


@gl.evm.contract_interface
class _Recipient:
    class View:
        pass

    class Write:
        pass


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _is_past_deadline() -> bool:
    return _now_utc() >= RESOLUTION_DEADLINE


def _addr_key(addr: Address) -> str:
    return addr.as_hex


def _parse_iso_date(value: str) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def _normalize_url(url: str) -> str:
    return url.strip().lower().rstrip("/")


def _is_trusted_source(url: str) -> bool:
    normalized = _normalize_url(url)
    for trusted in TRUSTED_SOURCES:
        trusted_norm = _normalize_url(trusted)
        if normalized == trusted_norm or normalized.startswith(trusted_norm + "/"):
            return True
        # Allow article paths under the trusted domain roots
        trusted_host = trusted_norm.replace("https://", "").replace("http://", "")
        candidate_host = normalized.replace("https://", "").replace("http://", "")
        if candidate_host.startswith(trusted_host):
            return True
    return False


def _is_apple_newsroom(url: str) -> bool:
    normalized = _normalize_url(url)
    return "apple.com/newsroom" in normalized


def _safe_json_loads(raw: typing.Any) -> dict:
    """Parse LLM/web JSON; raise classified LLM_ERROR on malformed payloads."""
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        raise gl.vm.UserError(f"{ERROR_LLM} Response is not JSON text or object")
    text = raw.strip()
    if text.startswith("```"):
        text = text.replace("```json", "").replace("```", "").strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise gl.vm.UserError(f"{ERROR_LLM} Malformed JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise gl.vm.UserError(f"{ERROR_LLM} JSON root must be an object")
    return parsed


def _validate_resolution_payload(data: dict) -> dict:
    required = ("released", "device_name", "release_date", "sources", "confidence")
    for field in required:
        if field not in data:
            raise gl.vm.UserError(f"{ERROR_LLM} Missing required field: {field}")

    if not isinstance(data["released"], bool):
        raise gl.vm.UserError(f"{ERROR_LLM} Field 'released' must be boolean")

    if not isinstance(data["device_name"], str):
        raise gl.vm.UserError(f"{ERROR_LLM} Field 'device_name' must be string")

    if not isinstance(data["release_date"], str):
        raise gl.vm.UserError(f"{ERROR_LLM} Field 'release_date' must be string")

    if not isinstance(data["sources"], list) or len(data["sources"]) == 0:
        raise gl.vm.UserError(f"{ERROR_LLM} Field 'sources' must be a non-empty list")

    confidence = data["confidence"]
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
        raise gl.vm.UserError(f"{ERROR_LLM} Field 'confidence' must be a number")
    if confidence < 0.0 or confidence > 1.0:
        raise gl.vm.UserError(f"{ERROR_LLM} Field 'confidence' must be between 0 and 1")

    release_date = _parse_iso_date(data["release_date"])
    if data["released"] and release_date is None:
        raise gl.vm.UserError(f"{ERROR_LLM} Invalid release_date format")

    trusted_sources: list[str] = []
    for src in data["sources"]:
        if not isinstance(src, str) or not src.strip():
            raise gl.vm.UserError(f"{ERROR_LLM} Each source must be a non-empty string URL")
        if _is_trusted_source(src):
            trusted_sources.append(src.strip())

    if data["released"] and not trusted_sources:
        raise gl.vm.UserError(f"{ERROR_EXPECTED} No trusted official sources provided")

    return {
        "released": data["released"],
        "device_name": data["device_name"].strip(),
        "release_date": data["release_date"].strip(),
        "sources": trusted_sources if trusted_sources else [str(s) for s in data["sources"]],
        "confidence": float(confidence),
    }


def _official_evidence_confirmed(payload: dict) -> bool:
    """
    Equivalence rule for YES:
    - Apple Newsroom confirms the launch, OR
    - multiple trusted sources confirm the launch
    Only official product releases count (enforced via LLM instructions + source checks).
    """
    if not payload["released"]:
        return False
    if payload["confidence"] < MIN_CONFIDENCE:
        return False

    release_date = _parse_iso_date(payload["release_date"])
    if release_date is None or release_date >= RESOLUTION_DEADLINE:
        return False

    sources = payload["sources"]
    apple_confirmed = any(_is_apple_newsroom(s) for s in sources)
    trusted_count = sum(1 for s in sources if _is_trusted_source(s))

    if apple_confirmed:
        return True
    if trusted_count >= 2:
        return True
    return False


def _fetch_source_snippets(sources: list[str]) -> str:
    snippets: list[str] = []
    for url in sources:
        try:
            response = gl.nondet.web.get(url)
            body = response.body
            if isinstance(body, (bytes, bytearray)):
                text = body.decode("utf-8", errors="replace")
            else:
                text = str(body)
            # Keep prompts bounded
            snippets.append(f"SOURCE_URL: {url}\nCONTENT:\n{text[:12000]}\n")
        except Exception as exc:  # noqa: BLE001 - classify below
            message = str(exc).lower()
            if "timeout" in message or "temporar" in message or "503" in message or "502" in message:
                raise gl.vm.UserError(f"{ERROR_TRANSIENT} Failed fetching {url}: {exc}") from exc
            raise gl.vm.UserError(f"{ERROR_EXTERNAL} Failed fetching {url}: {exc}") from exc
    return "\n---\n".join(snippets)


def _build_resolution_prompt(web_corpus: str) -> str:
    return f"""
You are adjudicating a GenLayer prediction market using only official public evidence.

Prediction:
{PREDICTION_STATEMENT}

Deadline (exclusive upper bound for YES): {RESOLUTION_DEADLINE_ISO}

Trusted sources provided below (Apple Newsroom, Apple.com, Apple Events, Reuters, Bloomberg, CNBC, The Verge, TechCrunch).

Rules:
- Accept ONLY official product releases / launches of a foldable iPhone by Apple.
- IGNORE rumors, patents, leaks, concept phones, analyst predictions, and unofficial speculation.
- If evidence is insufficient or only unofficial, set released=false.
- release_date must be ISO-8601 date (YYYY-MM-DD or full datetime). Use "" if unknown and released=false.
- sources must be URLs from the trusted corpus that support your conclusion.
- confidence is a float from 0 to 1.

Return JSON ONLY with this exact schema (no markdown, no commentary):
{{
  "released": true,
  "device_name": "iPhone Fold",
  "release_date": "2027-09-15",
  "sources": ["https://www.apple.com/newsroom/..."],
  "confidence": 0.99
}}

WEB CORPUS:
{web_corpus}
""".strip()


def _leader_resolve() -> dict:
    web_corpus = _fetch_source_snippets(TRUSTED_SOURCES)
    prompt = _build_resolution_prompt(web_corpus)
    try:
        raw = gl.nondet.exec_prompt(prompt, response_format="json")
    except Exception as exc:  # noqa: BLE001
        raise gl.vm.UserError(f"{ERROR_LLM} exec_prompt failed: {exc}") from exc

    payload = _validate_resolution_payload(_safe_json_loads(raw))
    outcome_yes = _official_evidence_confirmed(payload)
    # Return only calldata-safe types (no floats) for consensus encoding
    return {
        "outcome": "YES" if outcome_yes else "NO",
        "released": outcome_yes,
        "device_name": payload["device_name"] if outcome_yes else "",
        "release_date": payload["release_date"] if outcome_yes else "",
        "sources": payload["sources"],
        "confidence_bps": int(round(float(payload["confidence"]) * 10000)),
    }


def _handle_leader_error(leaders_res: typing.Any, leader_fn: typing.Callable[[], dict]) -> bool:
    leader_msg = leaders_res.message if hasattr(leaders_res, "message") else str(leaders_res)
    try:
        leader_fn()
        return False
    except gl.vm.UserError as exc:
        validator_msg = exc.message if hasattr(exc, "message") else str(exc)
        if validator_msg.startswith(ERROR_EXPECTED) or validator_msg.startswith(ERROR_EXTERNAL):
            return validator_msg == leader_msg
        if validator_msg.startswith(ERROR_TRANSIENT) and leader_msg.startswith(ERROR_TRANSIENT):
            return True
        return False
    except Exception:
        return False


def _bps_to_confidence(value: typing.Any) -> float:
    try:
        return float(value) / 10000.0
    except (TypeError, ValueError):
        return 0.0


def _results_equivalent(leader: dict, validator: dict) -> bool:
    """
    Non-strict equivalence for web/LLM adjudication:
    agree on binary outcome; tolerate differing device names/sources/confidence.
    """
    if leader.get("outcome") != validator.get("outcome"):
        return False
    if leader.get("released") != validator.get("released"):
        return False
    # Both must apply the same official-evidence rule for YES
    if leader["outcome"] == "YES":
        return _official_evidence_confirmed(
            {
                "released": True,
                "device_name": leader.get("device_name", ""),
                "release_date": leader.get("release_date", ""),
                "sources": leader.get("sources", []),
                "confidence": _bps_to_confidence(leader.get("confidence_bps", 0)),
            }
        ) and _official_evidence_confirmed(
            {
                "released": True,
                "device_name": validator.get("device_name", ""),
                "release_date": validator.get("release_date", ""),
                "sources": validator.get("sources", []),
                "confidence": _bps_to_confidence(validator.get("confidence_bps", 0)),
            }
        )
    return True


def _validator_resolve(leaders_res: typing.Any) -> bool:
    if not isinstance(leaders_res, gl.vm.Return):
        return _handle_leader_error(leaders_res, _leader_resolve)
    leader_data = leaders_res.calldata
    if not isinstance(leader_data, dict):
        return False
    my_result = _leader_resolve()
    return _results_equivalent(leader_data, my_result)


class FoldPredict(gl.Contract):
    prediction_statement: str
    resolution_date: str
    market_status: str
    outcome: str
    device_name: str
    release_date: str
    confidence_bps: u256
    resolution_sources: str
    total_yes: u256
    total_no: u256
    yes_bets: TreeMap[Address, u256]
    no_bets: TreeMap[Address, u256]
    participants: DynArray[Address]
    claimed: TreeMap[Address, bool]
    settled: bool

    def __init__(self):
        self.prediction_statement = PREDICTION_STATEMENT
        self.resolution_date = RESOLUTION_DEADLINE_ISO
        self.market_status = "OPEN"
        self.outcome = ""
        self.device_name = ""
        self.release_date = ""
        self.confidence_bps = u256(0)
        self.resolution_sources = "[]"
        self.total_yes = u256(0)
        self.total_no = u256(0)
        self.settled = False

    def _track_participant(self, addr: Address) -> None:
        for existing in self.participants:
            if existing == addr:
                return
        self.participants.append(addr)

    def _require_open_for_betting(self) -> None:
        if self.settled or self.market_status == "FINALIZED":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Market already settled")
        if _is_past_deadline():
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Betting closed after resolution deadline")
        if self.market_status != "OPEN":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Market is not open for betting")

    @gl.public.write.payable
    def bet_yes(self) -> None:
        stake = gl.message.value
        if stake == u256(0):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Stake must be greater than zero")
        self._require_open_for_betting()

        sender = gl.message.sender_address
        if sender in self.yes_bets or sender in self.no_bets:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Duplicate betting is not allowed")

        self.yes_bets[sender] = stake
        self.total_yes = self.total_yes + stake
        self._track_participant(sender)

    @gl.public.write.payable
    def bet_no(self) -> None:
        stake = gl.message.value
        if stake == u256(0):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Stake must be greater than zero")
        self._require_open_for_betting()

        sender = gl.message.sender_address
        if sender in self.yes_bets or sender in self.no_bets:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Duplicate betting is not allowed")

        self.no_bets[sender] = stake
        self.total_no = self.total_no + stake
        self._track_participant(sender)

    @gl.public.write
    def settle_market(self) -> None:
        if self.settled or self.market_status == "FINALIZED":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Market already settled")
        if not _is_past_deadline():
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Resolution deadline has not arrived")

        self.market_status = "PENDING_VALIDATION"

        # Leader searches trusted web sources + LLM; validators re-run independently.
        result = gl.vm.run_nondet_unsafe(_leader_resolve, _validator_resolve)

        if not isinstance(result, dict) or "outcome" not in result:
            raise gl.vm.UserError(f"{ERROR_LLM} Settlement returned invalid result")

        outcome = result["outcome"]
        if outcome not in ("YES", "NO"):
            raise gl.vm.UserError(f"{ERROR_LLM} Invalid outcome from consensus")

        self.outcome = outcome
        self.device_name = str(result.get("device_name", ""))
        self.release_date = str(result.get("release_date", ""))
        try:
            self.confidence_bps = u256(int(result.get("confidence_bps", 0)))
        except (TypeError, ValueError):
            self.confidence_bps = u256(0)
        sources = result.get("sources", [])
        self.resolution_sources = json.dumps(sources if isinstance(sources, list) else [])
        self.settled = True
        self.market_status = "FINALIZED"

    @gl.public.write
    def claim_reward(self) -> None:
        if not self.settled or self.market_status != "FINALIZED":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Market is not finalized")

        sender = gl.message.sender_address
        if sender in self.claimed and self.claimed[sender]:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Reward already claimed")

        payout = self._calculate_payout(sender)
        if payout == u256(0):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} No winnings to claim")

        self.claimed[sender] = True
        _Recipient(sender).emit_transfer(value=payout)

    def _calculate_payout(self, addr: Address) -> u256:
        total_pool = self.total_yes + self.total_no
        if total_pool == u256(0):
            return u256(0)

        if self.outcome == "YES":
            if addr not in self.yes_bets:
                return u256(0)
            user_stake = self.yes_bets[addr]
            winning_total = self.total_yes
        elif self.outcome == "NO":
            if addr not in self.no_bets:
                return u256(0)
            user_stake = self.no_bets[addr]
            winning_total = self.total_no
        else:
            return u256(0)

        if winning_total == u256(0):
            return u256(0)

        # winner_share = (user_stake / total_winning_stake) * total_pool
        return (user_stake * total_pool) // winning_total

    @gl.public.view
    def get_market_info(self) -> dict[str, typing.Any]:
        return {
            "prediction_statement": self.prediction_statement,
            "resolution_date": self.resolution_date,
            "market_status": self.market_status,
            "outcome": self.outcome,
            "total_yes": self.total_yes,
            "total_no": self.total_no,
            "total_pool": self.total_yes + self.total_no,
            "settled": self.settled,
            "participant_count": len(self.participants),
        }

    @gl.public.view
    def get_market_status(self) -> str:
        if self.market_status == "FINALIZED":
            return "Finalized"
        if self.market_status == "PENDING_VALIDATION":
            return "Pending Validation"
        if _is_past_deadline():
            return "Awaiting Settlement"
        return "Market Open"

    @gl.public.view
    def get_resolution_result(self) -> dict[str, typing.Any]:
        return {
            "settled": self.settled,
            "outcome": self.outcome,
            "device_name": self.device_name,
            "release_date": self.release_date,
            "confidence_bps": self.confidence_bps,
            "sources": self.resolution_sources,
            "market_status": self.market_status,
        }

    @gl.public.view
    def get_bet(self, user: str) -> dict[str, typing.Any]:
        addr = Address(user)
        side = ""
        stake = u256(0)
        if addr in self.yes_bets:
            side = "YES"
            stake = self.yes_bets[addr]
        elif addr in self.no_bets:
            side = "NO"
            stake = self.no_bets[addr]
        claimed = addr in self.claimed and self.claimed[addr]
        potential = self._calculate_payout(addr) if self.settled else u256(0)
        return {
            "side": side,
            "stake": stake,
            "claimed": claimed,
            "potential_payout": potential,
        }

    @gl.public.view
    def get_participants(self) -> list[str]:
        return [_addr_key(addr) for addr in self.participants]

    @gl.public.view
    def get_totals(self) -> dict[str, u256]:
        return {
            "total_yes": self.total_yes,
            "total_no": self.total_no,
            "total_pool": self.total_yes + self.total_no,
        }

    @gl.public.view
    def preview_payout(self, user: str) -> u256:
        return self._calculate_payout(Address(user))
