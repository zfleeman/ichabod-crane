"""send-mail's rules: one recipient, one sender, retry 4xx, stop on 5xx, an hourly cap, and a redacted password."""

import importlib.machinery
import importlib.util
import io
import pathlib
import smtplib
import time
from typing import ClassVar

import pytest

# The script has no .py extension, so it is loaded by path rather than imported.
_loader = importlib.machinery.SourceFileLoader(
    "send_mail", str(pathlib.Path(__file__).parents[1] / "home/bin/send-mail")
)
sm = importlib.util.module_from_spec(importlib.util.spec_from_loader(_loader.name, _loader))
_loader.exec_module(sm)

PASSWORD = "hunter2-app-password"


class FakeSMTP:
    """Stands in for smtplib.SMTP_SSL. Each connection takes the next outcome: None sends, an exception raises."""

    outcomes: ClassVar[list] = []
    sent: ClassVar[list] = []

    def __init__(self, host, port, timeout):
        self.outcome = FakeSMTP.outcomes.pop(0) if FakeSMTP.outcomes else None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def login(self, user, password):
        assert (user, password) == (sm.SENDER, PASSWORD)

    def send_message(self, msg, from_addr, to_addrs):
        if self.outcome:
            raise self.outcome
        FakeSMTP.sent.append((msg, from_addr, to_addrs))


@pytest.fixture
def box(tmp_path, monkeypatch):
    """A fake home: an env file with the password, an empty send log, no real SMTP and no real sleeping."""
    env = tmp_path / "env"
    env.write_text(f"SMTP_PASSWORD='{PASSWORD}'\n")
    monkeypatch.setattr(sm, "ENV_FILE", str(env))
    monkeypatch.setattr(sm, "SENT_FILE", str(tmp_path / "sent"))
    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSMTP)
    sleeps = []
    monkeypatch.setattr(time, "sleep", sleeps.append)
    FakeSMTP.outcomes, FakeSMTP.sent = [], []
    return tmp_path, sleeps


def run(monkeypatch, argv, body="Hello Zach.\n"):
    monkeypatch.setattr("sys.stdin", io.StringIO(body))
    return sm.main(argv)


def test_sends_to_zach_from_ichabod(box, monkeypatch):
    assert run(monkeypatch, ["Card 42 is done"]) == 0
    [(msg, from_addr, to_addrs)] = FakeSMTP.sent
    assert (from_addr, to_addrs) == (sm.SENDER, [sm.RECIPIENT])
    assert msg["To"] == sm.RECIPIENT
    assert msg["From"].addresses[0].addr_spec == sm.SENDER
    assert msg["Subject"] == "Card 42 is done"
    assert msg["In-Reply-To"] is None


def test_in_reply_to_sets_both_threading_headers(box, monkeypatch):
    assert run(monkeypatch, ["--in-reply-to", "<CAabc123@mail.gmail.com>", "Re: a request"]) == 0
    [(msg, _, _)] = FakeSMTP.sent
    assert msg["In-Reply-To"] == "<CAabc123@mail.gmail.com>"
    assert msg["References"] == "<CAabc123@mail.gmail.com>"


@pytest.mark.parametrize(
    "argv",
    [
        pytest.param(["Subject\nBcc: someone@example.com"], id="a line break in the subject"),
        pytest.param(["   "], id="an empty subject"),
        pytest.param(["--in-reply-to", "not given", "Re: x"], id="a Message-ID that is not one"),
        pytest.param(["--in-reply-to", "<a@b>\r\nBcc: x@y", "Re: x"], id="a Message-ID with a header in it"),
    ],
)
def test_bad_arguments_send_nothing(box, monkeypatch, argv):
    with pytest.raises(SystemExit):
        run(monkeypatch, argv)
    assert FakeSMTP.sent == []


def test_empty_body_sends_nothing(box, monkeypatch):
    with pytest.raises(SystemExit):
        run(monkeypatch, ["Subject"], body="\n")
    assert FakeSMTP.sent == []


def test_4xx_is_retried(box, monkeypatch):
    _, sleeps = box
    FakeSMTP.outcomes = [smtplib.SMTPDataError(451, b"try again later")]
    assert run(monkeypatch, ["Subject"]) == 0
    assert len(FakeSMTP.sent) == 1
    assert sleeps == [sm.RETRY_DELAYS_SECONDS[0]]


def test_dropped_connection_is_retried(box, monkeypatch):
    FakeSMTP.outcomes = [smtplib.SMTPServerDisconnected("gone")]
    assert run(monkeypatch, ["Subject"]) == 0


def test_4xx_gives_up_after_the_last_retry(box, monkeypatch):
    _, sleeps = box
    FakeSMTP.outcomes = [smtplib.SMTPDataError(451, b"later")] * 3
    assert run(monkeypatch, ["Subject"]) == 1
    assert sleeps == list(sm.RETRY_DELAYS_SECONDS)


def test_5xx_stops_at_once(box, monkeypatch):
    _, sleeps = box
    FakeSMTP.outcomes = [smtplib.SMTPDataError(550, b"no")]
    assert run(monkeypatch, ["Subject"]) == 1
    assert sleeps == []


def test_refused_recipient_uses_its_code(box, monkeypatch):
    FakeSMTP.outcomes = [smtplib.SMTPRecipientsRefused({sm.RECIPIENT: (550, b"no such user")})]
    assert run(monkeypatch, ["Subject"]) == 1


def test_password_never_reaches_the_error(box, monkeypatch, capsys):
    FakeSMTP.outcomes = [smtplib.SMTPDataError(554, f"rejected {PASSWORD}".encode())]
    assert run(monkeypatch, ["Subject"]) == 1
    err = capsys.readouterr().err
    assert PASSWORD not in err
    assert "[redacted]" in err


def test_hourly_cap_stops_a_loop(box, monkeypatch):
    home, _ = box
    now = time.time()
    (home / "sent").write_text("".join(f"{now - 60}\n" for _ in range(sm.MAX_SENDS_PER_HOUR)))
    assert run(monkeypatch, ["Subject"]) == 1
    assert FakeSMTP.sent == []


def test_sends_older_than_an_hour_do_not_count(box, monkeypatch):
    home, _ = box
    old = time.time() - 3700
    (home / "sent").write_text("".join(f"{old}\n" for _ in range(sm.MAX_SENDS_PER_HOUR)))
    assert run(monkeypatch, ["Subject"]) == 0
    assert len((home / "sent").read_text().split()) == 1


def test_missing_password_fails_loudly(box, monkeypatch):
    home, _ = box
    (home / "env").write_text("KANBOARD_TOKEN='x'\n")
    assert run(monkeypatch, ["Subject"]) == 1
    assert FakeSMTP.sent == []
