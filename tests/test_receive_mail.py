"""The parts of receive-mail that decide what is trusted: the gate, the DMARC check, and the reader's contract."""

import base64
import email
import email.policy
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


def raw_message(from_header="Zach <zfleeman@gmail.com>", body="Please build a thing.\r\n", extra=""):
    headers = f"From: {from_header}\r\n{extra}To: ichabod@ichabod-crane.net\r\nSubject: A request\r\nDate: Mon, 14 Sep 2026 10:00:00 +0000\r\n"
    return f"{headers}\r\n{body}".encode()


def signed(raw, domain="gmail.com", length=False):
    return (
        dkim.sign(
            raw, b"s1", domain.encode(), PRIVATE_PEM, include_headers=[b"from", b"subject", b"date"], length=length
        )
        + raw
    )


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


def gate(raw, age_seconds=60):
    return rm.gate(email.message_from_bytes(raw, policy=email.policy.default), raw, time.time() - age_seconds)


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
    assert gate(signed(raw_message()), age_seconds=49 * 3600) == "older than 48 hours"


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
