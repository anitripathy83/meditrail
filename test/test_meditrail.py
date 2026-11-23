"""
Tests every rule in contracts/MediTrail.sol on a local in-memory chain.
No network and no test ETH needed.

Run from the repo root:
    pip install "web3[tester]" pytest
    npm install && npm run compile     # writes build.json
    python -m pytest test/ -q
"""
import json
import pathlib
import time

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3

ROOT = pathlib.Path(__file__).resolve().parents[1]
BUILD = json.loads((ROOT / "build.json").read_text())

# Enum values, in the same order as the contract
R_NONE, MANUFACTURER, DISTRIBUTOR, PHARMACY, SENSOR = range(5)
S_NONE, S_MADE, S_TO_DIST, S_WITH_DIST, S_TO_PHARM, S_AT_PHARM, S_SOLD = range(7)
V_UNKNOWN, V_IN_CHAIN, V_READY, V_SOLD, V_COMPROMISED, V_RECALLED, V_EXPIRED = range(7)

BOX = "INS-0001"
BATCH = "B-2611"
YEAR = 365 * 24 * 3600
CERT = Web3.keccak(b"%PDF demo certificate for batch B-2611")


def seal(code):
    return Web3.keccak(text=code)


@pytest.fixture
def env():
    w3 = Web3(Web3.EthereumTesterProvider())
    admin, maker, dist, pharm, pharm2, dist2, stranger, maker2 = w3.eth.accounts[:8]
    sensor = Account.create()
    other_sensor = Account.create()
    factory = w3.eth.contract(abi=BUILD["abi"], bytecode=BUILD["bytecode"])
    tx = factory.constructor().transact({"from": admin})
    c = w3.eth.contract(address=w3.eth.get_transaction_receipt(tx).contractAddress, abi=BUILD["abi"])
    until = now(w3) + YEAR
    for wallet, role, name in [
        (maker, MANUFACTURER, "Gulf Pharma Labs (demo)"),
        (maker2, MANUFACTURER, "Second Maker (demo)"),
        (dist, DISTRIBUTOR, "Desert Logistics (demo)"),
        (dist2, DISTRIBUTOR, "Second Distributor (demo)"),
        (pharm, PHARMACY, "Al Noor Pharmacy (demo)"),
        (pharm2, PHARMACY, "Second Pharmacy (demo)"),
        (sensor.address, SENSOR, "Cold box sensor #1 (demo)"),
        (other_sensor.address, SENSOR, "Cold box sensor #2 (demo)"),
    ]:
        c.functions.setMember(wallet, role, name, until).transact({"from": admin})
    return dict(w3=w3, c=c, admin=admin, maker=maker, maker2=maker2, dist=dist, dist2=dist2,
                pharm=pharm, pharm2=pharm2, stranger=stranger, sensor=sensor, other_sensor=other_sensor)


# ---------------- helpers ----------------

def now(w3):
    return w3.eth.get_block("latest")["timestamp"]


def travel(w3, seconds):
    tester = w3.provider.ethereum_tester
    tester.time_travel(now(w3) + seconds)
    tester.mine_blocks(1)


def refused(fn, sender, message):
    """Refused with exactly this message, both as a free simulated call (what the
    website does first) and as a real transaction."""
    with pytest.raises(Exception) as e:
        fn.call({"from": sender})
    assert message in str(e.value), str(e.value)
    with pytest.raises(Exception) as e:
        fn.transact({"from": sender})
    assert message in str(e.value), str(e.value)


def register(e, box=BOX, batch=BATCH, maker=None, expiry_in=YEAR, sensor=None):
    e["c"].functions.registerBox(
        box, "Insulin glargine 100 U/ml (demo)", batch, now(e["w3"]) + expiry_in,
        (sensor or e["sensor"]).address, CERT,
    ).transact({"from": maker or e["maker"]})


def offer(e, sender, to, code, box=BOX):
    e["c"].functions.offer(box, to, seal(code), "").transact({"from": sender})


def accept(e, sender, code, box=BOX):
    e["c"].functions.accept(box, code).transact({"from": sender})


def to_pharmacy(e, box=BOX):
    offer(e, e["maker"], e["dist"], "SEAL-A1", box)
    accept(e, e["dist"], "SEAL-A1", box)
    offer(e, e["dist"], e["pharm"], "SEAL-B2", box)
    accept(e, e["pharm"], "SEAL-B2", box)


def signed(e, temp, taken_at=None, key=None, box=BOX):
    c = e["c"]
    taken_at = taken_at or now(e["w3"])
    inner = c.functions.readingHash(box, temp, taken_at).call()
    sig = Account.sign_message(encode_defunct(primitive=inner), (key or e["sensor"]).key).signature
    return c.functions.submitReading(box, temp, taken_at, sig)


def box(e, box_id=BOX):
    return e["c"].functions.getBox(box_id).call()


def stage(e, box_id=BOX):
    return box(e, box_id)[4]


def verdict(e, box_id=BOX):
    return e["c"].functions.verdictOf(box_id).call()


def kinds(e, box_id=BOX):
    return [h[0] for h in e["c"].functions.getHistory(box_id).call()]


# ---------------- happy path ----------------

def test_full_journey(env):
    e = env
    register(e)
    assert stage(e) == S_MADE and verdict(e) == V_IN_CHAIN

    offer(e, e["maker"], e["dist"], "SEAL-A1")
    assert stage(e) == S_TO_DIST
    assert box(e)[7] == e["dist"]           # pendingTo
    assert box(e)[6] == e["maker"]          # holder is still the maker until accepted

    accept(e, e["dist"], "SEAL-A1")
    assert stage(e) == S_WITH_DIST and box(e)[6] == e["dist"]

    signed(e, 41).transact({"from": e["dist"]})
    signed(e, 63, now(e["w3"]) + 1).transact({"from": e["dist"]})

    offer(e, e["dist"], e["pharm"], "SEAL-B2")
    accept(e, e["pharm"], "SEAL-B2")
    assert stage(e) == S_AT_PHARM and verdict(e) == V_READY

    e["c"].functions.sell(BOX).transact({"from": e["pharm"]})
    assert stage(e) == S_SOLD and verdict(e) == V_SOLD

    b = box(e)
    assert (b[12], b[13], b[14]) == (41, 63, 2)   # min, max, count
    assert not b[11]                             # not compromised
    assert kinds(e) == ["Registered", "Offered", "Received", "Offered", "Received", "Sold"]
    history = e["c"].functions.getHistory(BOX).call()
    assert history[2][3] == e["dist"] and history[2][4] == DISTRIBUTOR   # signer and role recorded
    assert len(e["c"].functions.getReadings(BOX).call()) == 2


def test_unknown_box_and_public_reads(env):
    e = env
    assert verdict(e, "FAKE-999") == V_UNKNOWN
    assert box(e, "FAKE-999")[4] == S_NONE
    register(e)
    assert e["c"].functions.getBoxIds().call() == [BOX]
    wallets, members = e["c"].functions.getMembers().call()
    assert e["maker"] in wallets and len(members) == 8
    member, active = e["c"].functions.getMember(e["pharm"]).call()
    assert member[0] == PHARMACY and active


# ---------------- regulator ----------------

def test_only_regulator_approves(env):
    e = env
    until = now(e["w3"]) + YEAR
    refused(e["c"].functions.setMember(e["stranger"], PHARMACY, "Fake Pharmacy", until), e["maker"],
            "Only the regulator can approve companies")
    refused(e["c"].functions.setMember(e["stranger"], PHARMACY, "Fake Pharmacy", now(e["w3"]) - 10), e["admin"],
            "The licence end date must be in the future")
    refused(e["c"].functions.setMember(e["stranger"], PHARMACY, "", until), e["admin"],
            "Enter the company or sensor name")


def test_removed_company_is_refused(env):
    e = env
    e["c"].functions.setMember(e["maker"], R_NONE, "", 0).transact({"from": e["admin"]})
    refused(e["c"].functions.registerBox(BOX, "x", BATCH, now(e["w3"]) + YEAR, e["sensor"].address, CERT),
            e["maker"], "Only an approved manufacturer can register a box")


# ---------------- registration ----------------

def test_register_rules(env):
    e, c = env, env["c"]
    exp = now(e["w3"]) + YEAR
    refused(c.functions.registerBox(BOX, "x", BATCH, exp, e["sensor"].address, CERT), e["dist"],
            "Only an approved manufacturer can register a box")
    refused(c.functions.registerBox(BOX, "x", BATCH, exp, e["stranger"], CERT), e["maker"],
            "Attach a sensor the regulator has approved")
    refused(c.functions.registerBox(BOX, "x", BATCH, now(e["w3"]) - 1, e["sensor"].address, CERT), e["maker"],
            "The expiry date must be in the future")
    refused(c.functions.registerBox("", "x", BATCH, exp, e["sensor"].address, CERT), e["maker"],
            "Enter a box ID")
    register(e)
    refused(c.functions.registerBox(BOX, "x", BATCH, exp, e["sensor"].address, CERT), e["maker"],
            "This box ID already exists")
    refused(c.functions.registerBox("INS-0099", "x", BATCH, exp, e["sensor"].address, CERT), e["maker2"],
            "This batch number belongs to another manufacturer")


# ---------------- handover: offer ----------------

def test_offer_rules(env):
    e, c = env, env["c"]
    register(e)
    refused(c.functions.offer(BOX, e["dist"], seal("X"), ""), e["stranger"],
            "Only the company holding this box can hand it over")
    refused(c.functions.offer(BOX, e["pharm"], seal("X"), ""), e["maker"],
            "Out of order: a box must go to a distributor next")
    refused(c.functions.offer(BOX, e["stranger"], seal("X"), ""), e["maker"],
            "Out of order: a box must go to a distributor next")
    refused(c.functions.offer(BOX, e["dist"], b"\x00" * 32, ""), e["maker"],
            "Create a seal code first")
    refused(c.functions.offer("NOPE-1", e["dist"], seal("X"), ""), e["maker"],
            "No box with this ID exists")
    offer(e, e["maker"], e["dist"], "SEAL-A1")
    refused(c.functions.offer(BOX, e["dist2"], seal("Y"), ""), e["maker"],
            "This box already has a handover waiting")
    accept(e, e["dist"], "SEAL-A1")
    refused(c.functions.offer(BOX, e["dist2"], seal("Y"), ""), e["dist"],
            "Out of order: a box must go to a pharmacy next")
    offer(e, e["dist"], e["pharm"], "SEAL-B2")
    accept(e, e["pharm"], "SEAL-B2")
    refused(c.functions.offer(BOX, e["pharm2"], seal("Z"), ""), e["pharm"],
            "This box is at the pharmacy: it can only be sold now")


def test_offer_to_company_with_expired_licence(env):
    e, c = env, env["c"]
    register(e)
    c.functions.setMember(e["dist"], DISTRIBUTOR, "Desert Logistics (demo)", now(e["w3"]) + 60).transact({"from": e["admin"]})
    travel(e["w3"], 120)
    refused(c.functions.offer(BOX, e["dist"], seal("X"), ""), e["maker"],
            "The receiving company's licence has expired")


# ---------------- handover: accept and reject ----------------

def test_accept_rules(env):
    e, c = env, env["c"]
    register(e)
    refused(c.functions.accept(BOX, "SEAL-A1"), e["dist"], "This box was not offered to you")
    offer(e, e["maker"], e["dist"], "SEAL-A1")
    refused(c.functions.accept(BOX, "SEAL-A1"), e["pharm"], "This box was not offered to you")
    refused(c.functions.accept(BOX, "SEAL-A1"), e["dist2"], "This box was not offered to you")
    refused(c.functions.accept(BOX, "WRONG"), e["dist"], "Seal code does not match")
    accept(e, e["dist"], "SEAL-A1")
    # the code is now public on chain, so it cannot be used again
    refused(c.functions.accept(BOX, "SEAL-A1"), e["dist"], "This box was not offered to you")


def test_reject_keeps_custody_with_sender(env):
    e, c = env, env["c"]
    register(e)
    offer(e, e["maker"], e["dist"], "SEAL-A1")
    refused(c.functions.reject(BOX, "seal broken"), e["pharm"], "This box was not offered to you")
    refused(c.functions.reject(BOX, ""), e["dist"], "Write why you are rejecting the box")
    c.functions.reject(BOX, "Tamper seal was broken").transact({"from": e["dist"]})
    b = box(e)
    assert b[4] == S_MADE and b[6] == e["maker"] and b[7] == "0x" + "00" * 20
    assert kinds(e)[-1] == "Rejected"
    refused(c.functions.accept(BOX, "SEAL-A1"), e["dist"], "This box was not offered to you")
    offer(e, e["maker"], e["dist"], "SEAL-A3")   # the maker can offer again with a new seal
    accept(e, e["dist"], "SEAL-A3")
    assert stage(e) == S_WITH_DIST


# ---------------- sensor readings ----------------

def test_readings_need_the_box_sensor_signature(env):
    e, c = env, env["c"]
    register(e)
    t = now(e["w3"])
    refused(signed(e, 50, t, key=e["other_sensor"]), e["maker"], "Reading not signed by this box's sensor")
    refused(signed(e, 50, t, key=Account.create()), e["maker"], "Reading not signed by this box's sensor")
    refused(c.functions.submitReading(BOX, 50, t, b"\x01" * 65), e["maker"], "Reading not signed by this box's sensor")
    # a valid signature for one temperature cannot be reused for another
    inner = c.functions.readingHash(BOX, 50, t).call()
    sig = Account.sign_message(encode_defunct(primitive=inner), e["sensor"].key).signature
    refused(c.functions.submitReading(BOX, 30, t, sig), e["maker"], "Reading not signed by this box's sensor")
    c.functions.submitReading(BOX, 50, t, sig).transact({"from": e["stranger"]})   # anyone can relay
    refused(c.functions.submitReading(BOX, 50, t, sig), e["maker"], "Reading is out of date")   # no replay
    refused(signed(e, 50, t + 3600), e["maker"], "Reading time is in the future")
    assert box(e)[14] == 1


def test_breach_locks_the_box(env):
    e, c = env, env["c"]
    register(e)
    offer(e, e["maker"], e["dist"], "SEAL-A1")
    signed(e, 112).transact({"from": e["dist"]})          # 11.2 C
    b = box(e)
    assert b[11] and b[13] == 112
    assert verdict(e) == V_COMPROMISED
    assert kinds(e)[-1] == "Temperature breach"
    note = c.functions.getHistory(BOX).call()[-1][1]
    assert note == "Reading 11.2 C is outside 2.0-8.0 C"
    refused(c.functions.accept(BOX, "SEAL-A1"), e["dist"], "This box had a temperature breach and is blocked")
    signed(e, 40, now(e["w3"]) + 1).transact({"from": e["dist"]})   # later good readings do not unlock it
    assert verdict(e) == V_COMPROMISED


def test_breached_box_cannot_be_sold(env):
    e, c = env, env["c"]
    register(e)
    to_pharmacy(e)
    signed(e, 5).transact({"from": e["pharm"]})           # 0.5 C: too cold is a breach too
    refused(c.functions.sell(BOX), e["pharm"], "This box had a temperature breach and is blocked")


def test_negative_temperature_note(env):
    e, c = env, env["c"]
    register(e)
    signed(e, -35).transact({"from": e["maker"]})
    assert c.functions.getHistory(BOX).call()[-1][1] == "Reading -3.5 C is outside 2.0-8.0 C"


# ---------------- selling ----------------

def test_sell_rules(env):
    e, c = env, env["c"]
    register(e)
    offer(e, e["maker"], e["dist"], "SEAL-A1")
    accept(e, e["dist"], "SEAL-A1")
    refused(c.functions.sell(BOX), e["pharm"], "Only the pharmacy holding this box can sell it")
    refused(c.functions.sell(BOX), e["dist"], "Only the pharmacy holding this box can sell it")
    offer(e, e["dist"], e["pharm"], "SEAL-B2")
    refused(c.functions.sell(BOX), e["pharm"], "Only the pharmacy holding this box can sell it")  # not accepted yet
    accept(e, e["pharm"], "SEAL-B2")
    refused(c.functions.sell(BOX), e["pharm2"], "Only the pharmacy holding this box can sell it")
    c.functions.sell(BOX).transact({"from": e["pharm"]})
    refused(c.functions.sell(BOX), e["pharm"], "This box was already sold")      # a copied code is caught here
    refused(signed(e, 50), e["pharm"], "This box was already sold")


def test_expired_box_cannot_be_sold(env):
    e, c = env, env["c"]
    register(e, expiry_in=3600)
    to_pharmacy(e)
    travel(e["w3"], 7200)
    assert verdict(e) == V_EXPIRED
    refused(c.functions.sell(BOX), e["pharm"], "This box has expired and cannot be sold")


# ---------------- licences ----------------

def test_expired_licence_is_refused(env):
    e, c = env, env["c"]
    register(e)
    c.functions.setMember(e["maker"], MANUFACTURER, "Gulf Pharma Labs (demo)", now(e["w3"]) + 60).transact({"from": e["admin"]})
    travel(e["w3"], 120)
    refused(c.functions.offer(BOX, e["dist"], seal("X"), ""), e["maker"], "Your licence has expired")
    refused(c.functions.registerBox("INS-0002", "x", BATCH, now(e["w3"]) + YEAR, e["sensor"].address, CERT),
            e["maker"], "Your licence has expired")
    member, active = c.functions.getMember(e["maker"]).call()
    assert not active


# ---------------- recalls ----------------

def test_batch_recall(env):
    e, c = env, env["c"]
    register(e)
    register(e, box="INS-0002")
    register(e, box="OTHER-1", batch="B-9999")
    offer(e, e["maker"], e["dist"], "SEAL-A1")
    refused(c.functions.recallBatch(BATCH, "Contamination"), e["stranger"],
            "Only the regulator or this batch's manufacturer can recall it")
    refused(c.functions.recallBatch(BATCH, ""), e["maker"], "Write the reason for the recall")
    refused(c.functions.recallBatch("B-0000", "x"), e["admin"], "No boxes exist in this batch")
    c.functions.recallBatch(BATCH, "Contamination found in lab retest").transact({"from": e["maker"]})
    assert verdict(e, BOX) == V_RECALLED and verdict(e, "INS-0002") == V_RECALLED
    assert verdict(e, "OTHER-1") == V_IN_CHAIN
    assert kinds(e, "INS-0002")[-1] == "Recalled"
    recall = c.functions.getRecall(BATCH).call()
    assert recall[0] and recall[1] == "Contamination found in lab retest" and recall[2] == e["maker"]
    refused(c.functions.accept(BOX, "SEAL-A1"), e["dist"], "This batch has been recalled")
    refused(c.functions.offer("INS-0002", e["dist"], seal("Q"), ""), e["maker"], "This batch has been recalled")
    refused(c.functions.recallBatch(BATCH, "again"), e["admin"], "This batch is already recalled")
    refused(c.functions.registerBox("INS-0003", "x", BATCH, now(e["w3"]) + YEAR, e["sensor"].address, CERT),
            e["maker"], "This batch has been recalled")


def test_regulator_can_recall(env):
    e, c = env, env["c"]
    register(e)
    to_pharmacy(e)
    c.functions.recallBatch(BATCH, "Regulator safety notice").transact({"from": e["admin"]})
    refused(c.functions.sell(BOX), e["pharm"], "This batch has been recalled")


# ---------------- corrections and certificates ----------------

def test_corrections_are_new_entries(env):
    e, c = env, env["c"]
    register(e)
    refused(c.functions.addCorrection(BOX, "x"), e["stranger"], "Only a company that handled this box can add a correction")
    refused(c.functions.addCorrection(BOX, ""), e["maker"], "Write what the correction is")
    before = c.functions.getHistory(BOX).call()
    c.functions.addCorrection(BOX, "Medicine name should read 100 U/ml").transact({"from": e["maker"]})
    after = c.functions.getHistory(BOX).call()
    assert after[: len(before)] == before and after[-1][0] == "Correction"
    c.functions.addCorrection(BOX, "Checked by regulator").transact({"from": e["admin"]})


def test_certificate_fingerprint(env):
    e, c = env, env["c"]
    register(e)
    assert c.functions.checkCertificate(BOX, CERT).call()
    assert not c.functions.checkCertificate(BOX, Web3.keccak(b"%PDF edited copy")).call()
    assert not c.functions.checkCertificate("FAKE-1", b"\x00" * 32).call()
