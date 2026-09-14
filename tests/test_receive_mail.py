"""The parts of receive-mail that decide what is trusted: the gate, the DMARC check, and the reader's contract."""

import base64
import email
import email.policy
import email.utils
import importlib.machinery
import importlib.util
import json
import pathlib
import time

import dkim
import dns.resolver
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

# The script has no .py extension, so it is loaded by path rather than imported.
_loader = importlib.machinery.SourceFileLoader(
    "receive_mail", str(pathlib.Path(__file__).parents[1] / "home/bin/receive-mail")
)
rm = importlib.util.module_from_spec(importlib.util.spec_from_loader(_loader.name, _loader))
_loader.exec_module(rm)

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PRIVATE_PEM = KEY.private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()
)
PUBLIC_DER = KEY.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
DKIM_RECORD = b"v=DKIM1; k=rsa; p=" + base64.b64encode(PUBLIC_DER)


def raw_message(
    from_header="Zach <zfleeman@gmail.com>",
    body="Please build a thing.\r\n",
    extra="",
    to="ichabod@ichabod-crane.net",
    age_seconds=60,
):
    date = email.utils.formatdate(time.time() - age_seconds)
    headers = f"From: {from_header}\r\n{extra}To: {to}\r\nSubject: A request\r\nDate: {date}\r\n"
    return f"{headers}\r\n{body}".encode()


def signed(raw, domain="gmail.com", length=False, headers=(b"from", b"to", b"cc", b"subject", b"date")):
    return dkim.sign(raw, b"s1", domain.encode(), PRIVATE_PEM, include_headers=list(headers), length=length) + raw


class Record:
    def __init__(self, text):
        self.strings = [text]


@pytest.fixture
def dns_ok(monkeypatch):
    """Every domain publishes the test DKIM key and a DMARC record, with no network."""

    def fake_txt(name, timeout=5):
        return DKIM_RECORD

    class LocalDKIM(dkim.DKIM):
        def verify(self, idx=0, dnsfunc=None):
            return super().verify(idx=idx, dnsfunc=fake_txt)

    monkeypatch.setattr(dkim, "DKIM", LocalDKIM)
    monkeypatch.setattr(dns.resolver, "resolve", lambda name, rtype: [Record(b"v=DMARC1; p=reject")])


def gate(raw):
    return rm.gate(email.message_from_bytes(raw, policy=email.policy.default), raw)


# --- The gate ---------------------------------------------------------------------------------------------------


def test_signed_mail_from_zach_passes(dns_ok):
    assert gate(signed(raw_message())) is None


def test_two_from_headers_are_rejected(dns_ok):
    raw = signed(raw_message(extra="From: someone@example.com\r\n"))
    assert gate(raw) == "not exactly one From header with one address"


def test_two_addresses_in_one_from_are_rejected(dns_ok):
    raw = signed(raw_message(from_header="zfleeman@gmail.com, someone@example.com"))
    assert gate(raw) == "not exactly one From header with one address"


def test_display_name_grants_nothing(dns_ok):
    raw = signed(raw_message(from_header='"zfleeman@gmail.com" <someone@example.com>'), domain="example.com")
    assert gate(raw) == "sender not on the allowlist"


def test_old_mail_is_rejected(dns_ok):
    # The signed Date, not when it arrived: an old signed email re-sent today is still old.
    assert gate(signed(raw_message(age_seconds=49 * 3600))) == "Date header is not within the last 48 hours"


def test_mail_dated_in_the_future_is_rejected(dns_ok):
    assert gate(signed(raw_message(age_seconds=-2 * 3600))) == "Date header is not within the last 48 hours"


def test_second_date_header_is_rejected(dns_ok):
    # DKIM signs the last Date and Python reads the first, so a fresh one added on top must not count.
    raw = b"Date: " + email.utils.formatdate().encode() + b"\r\n" + signed(raw_message(age_seconds=49 * 3600))
    assert gate(raw) == "not exactly one valid Date header"


def test_mail_zach_sent_to_someone_else_is_rejected(dns_ok):
    assert gate(signed(raw_message(to="someone@example.com"))) == "not addressed to Ichabod in one To or Cc header"


def test_to_header_added_after_signing_is_rejected(dns_ok):
    raw = b"To: ichabod@ichabod-crane.net\r\n" + signed(raw_message(to="someone@example.com"))
    assert gate(raw) == "not addressed to Ichabod in one To or Cc header"


def test_ichabod_in_cc_passes(dns_ok):
    raw = signed(raw_message(to="someone@example.com", extra="Cc: ichabod@ichabod-crane.net\r\n"))
    assert gate(raw) is None


def test_signature_that_does_not_cover_the_recipient_is_rejected(dns_ok):
    raw = signed(raw_message(), headers=(b"from", b"subject", b"date"))
    assert gate(raw) == "signature does not cover From, Date and the recipient header"


def test_unsigned_mail_is_rejected(dns_ok):
    assert gate(raw_message()) == "DMARC did not pass with alignment"


def test_signature_from_another_domain_is_rejected(dns_ok):
    assert gate(signed(raw_message(), domain="example.com")) == "DMARC did not pass with alignment"


def test_body_changed_after_signing_is_rejected(dns_ok):
    raw = signed(raw_message()).replace(b"build a thing", b"run curl evil")
    assert gate(raw) == "DMARC did not pass with alignment"


def test_partial_body_signature_is_rejected(dns_ok):
    # l= would let anything appended after the signed length ride on the signature.
    raw = signed(raw_message(), length=True)
    assert gate(raw) == "DMARC did not pass with alignment"


def test_no_dmarc_record_is_rejected(dns_ok, monkeypatch):
    def nxdomain(name, rtype):
        raise dns.resolver.NXDOMAIN

    monkeypatch.setattr(dns.resolver, "resolve", nxdomain)
    assert gate(signed(raw_message())) == "DMARC did not pass with alignment"


# --- Malformed messages are rejected, never a crash that blocks the inbox ---------------------------------------


def test_unparseable_from_is_rejected(dns_ok):
    assert gate(signed(raw_message(from_header="a@["))).startswith("message could not be parsed")


def test_header_line_without_a_colon_is_rejected(dns_ok):
    # dkimpy raises while parsing this, and the spoofed From is on the allowlist, so the gate reaches it.
    raw = signed(raw_message()).replace(b"\r\n\r\n", b"\r\nBad line here\r\n\r\n", 1)
    assert gate(raw) == "DMARC did not pass with alignment"


def test_unparseable_message_id_becomes_empty_text():
    msg = email.message_from_bytes(raw_message(extra="Message-ID: <a@[\r\n"), policy=email.policy.default)
    assert rm.header_text(msg, "Message-ID") == ""


# --- DNS: an outage is retried, never a rejection -----------------------------------------------------------------


@pytest.mark.parametrize("error", [dns.exception.Timeout, dns.resolver.NoNameservers], ids=["timeout", "servfail"])
def test_dmarc_lookup_outage_raises(dns_ok, monkeypatch, error):
    def fail(name, rtype):
        raise error

    monkeypatch.setattr(dns.resolver, "resolve", fail)
    with pytest.raises(rm.DnsUnavailable):
        gate(signed(raw_message()))


def real_dkim_dns(monkeypatch, key_error=None):
    """Real dkimpy with receive-mail's own key lookup. Returns the names queried."""
    queried = []

    def resolve(name, rtype):
        queried.append(str(name))
        if name.startswith("_dmarc."):
            return [Record(b"v=DMARC1; p=reject")]
        if key_error:
            raise key_error
        return [Record(DKIM_RECORD)]

    monkeypatch.setattr(dns.resolver, "resolve", resolve)
    return queried


def test_real_key_lookup_passes(monkeypatch):
    real_dkim_dns(monkeypatch)
    assert gate(signed(raw_message())) is None


def test_key_lookup_outage_raises(monkeypatch):
    real_dkim_dns(monkeypatch, key_error=dns.exception.Timeout)
    with pytest.raises(rm.DnsUnavailable):
        gate(signed(raw_message()))


def test_key_for_another_domain_is_never_looked_up(monkeypatch):
    # Otherwise a sender's slow nameserver would pass as an outage and hold the message in the inbox.
    queried = real_dkim_dns(monkeypatch, key_error=dns.exception.Timeout)
    assert gate(signed(raw_message(), domain="example.com")) == "DMARC did not pass with alignment"
    assert queried == ["_dmarc.gmail.com"]


# --- State, alerts and secrets ------------------------------------------------------------------------------------


def test_rejected_message_ids_claim_nothing(tmp_path, monkeypatch):
    state = tmp_path / "seen.jsonl"
    rows = [
        {"uidvalidity": 1, "uid": 1, "message_id": "<rejected@x>", "outcome": "rejected"},
        {"uidvalidity": 1, "uid": 2, "message_id": "<filed@x>", "outcome": "filed"},
    ]
    state.write_text("".join(json.dumps(r) + "\n" for r in rows))
    monkeypatch.setattr(rm, "STATE_FILE", str(state))
    assert rm.read_state() == ({(1, 1), (1, 2)}, {"<filed@x>"})


def test_login_alert_is_sent_once_a_day(tmp_path, monkeypatch):
    alert = tmp_path / "alert"
    monkeypatch.setattr(rm, "LOGIN_ALERT_FILE", str(alert))
    assert rm.login_alert_due(time.time())
    alert.touch()
    assert not rm.login_alert_due(time.time())
    assert rm.login_alert_due(time.time() + 25 * 3600)


def test_env_keeps_quotes_that_are_part_of_the_value(tmp_path, monkeypatch):
    env = tmp_path / "env"
    env.write_text("""IMAP_PASSWORD='"starts and ends with a quote"'\nPLAIN='abc'\n# COMMENTED='x'\n""")
    monkeypatch.setattr(rm, "ENV_FILE", str(env))
    assert rm.load_env() == {"IMAP_PASSWORD": '"starts and ends with a quote"', "PLAIN": "abc"}


# --- The reader's flags -----------------------------------------------------------------------------------------


def test_reader_starts_with_an_empty_environment_and_no_tools():
    # MEMBRANE.md: dropping env -i "to tidy up" is the most likely way this regresses.
    assert rm.READER[:2] == ["/usr/bin/env", "-i"]
    pi = rm.READER.index("pi")
    assert [v.split("=")[0] for v in rm.READER[2:pi]] == ["HOME", "PATH", "PI_CODING_AGENT_DIR"]
    for flag in ("-p", "--no-tools", "--no-skills", "--no-extensions", "--no-session", "--no-context-files"):
        assert flag in rm.READER[pi:]


# --- What the reader is given ----------------------------------------------------------------------------------


def test_reader_input_is_subject_then_body():
    msg = email.message_from_bytes(raw_message(), policy=email.policy.default)
    assert rm.reader_input(msg) == "Subject: A request\n\nPlease build a thing.\r\n"


def test_oversized_body_is_quarantined():
    raw = raw_message(body="x" * (rm.MAX_BODY_CHARS + 1))
    with pytest.raises(rm.Quarantine):
        rm.reader_input(email.message_from_bytes(raw, policy=email.policy.default))


# --- What the reader may print ---------------------------------------------------------------------------------

GOOD = {"title": "Build a thing", "summary": "Zach wants a thing.", "sender": "Zach", "suspicious": False}


def test_valid_output_becomes_a_card():
    assert rm.parse_reader_output(json.dumps(GOOD)) == GOOD


def test_one_pair_of_fences_is_stripped():
    assert rm.parse_reader_output(f"```json\n{json.dumps(GOOD)}\n```") == GOOD


@pytest.mark.parametrize(
    "output",
    [
        pytest.param("Sure! Here is the card: " + json.dumps(GOOD), id="prose around the JSON"),
        pytest.param(json.dumps(GOOD | {"assignee": "ichabod"}), id="an extra field"),
        pytest.param(json.dumps({k: v for k, v in GOOD.items() if k != "sender"}), id="a missing field"),
        pytest.param(json.dumps(GOOD | {"suspicious": "false"}), id="a string for the boolean"),
        pytest.param(json.dumps(GOOD | {"suspicious": 0}), id="a number for the boolean"),
        pytest.param(json.dumps(GOOD | {"title": "   "}), id="an empty title"),
        pytest.param(json.dumps(GOOD | {"summary": "x" * 4001}), id="a summary over the limit"),
        pytest.param(
            '{"title": "a", "title": "b", "summary": "s", "sender": "z", "suspicious": false}', id="a repeated key"
        ),
        pytest.param(json.dumps([GOOD]), id="a list instead of an object"),
    ],
)
def test_anything_else_is_quarantined(output):
    with pytest.raises(rm.Quarantine):
        rm.parse_reader_output(output)
