"""The page browser's passkey step: a WebAuthn virtual authenticator on one tab for one click, over
CDP (stdlib only)."""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import urlsplit

from page_secrets import Refused, attach, connect, eval_json


class PasskeyNotTaken(RuntimeError):
    """The click went through, and the site did not create or use the passkey: the page may have changed."""


# How long a passkey step waits after its click for the site to create or use the passkey. The
# authenticator holding it is on the tab only for that click and this wait.
PASSKEY_WAIT_SECONDS = 3.0
PASSKEY_NOT_CREATED = "The site created no passkey after that click, so none was saved. Take a fresh snapshot."
PASSKEY_NOT_USED = "The site did not ask for the passkey after that click. Take a fresh snapshot."


class Passkey:
    """A virtual authenticator on one tab for one passkey step: it holds the saved passkey for a
    sign-in, or none to create one, and is removed when the step ends; Chromium also removes it when
    this CDP connection closes. It needs a person's presence, which is given only at the click, so a
    request the page made on its own before then is never answered."""

    def __init__(self, port: int, target_id: str, step: dict[str, Any]) -> None:
        self.step = step
        self.client = connect(port)
        self.authenticator: str | None = None
        try:
            self.session = attach(self.client, target_id)
            origin = eval_json(self.client, self.session, "location.origin", context_id=self.client.context_id)
            if origin != step["origin"]:
                raise Refused(f"The page is on {origin}, and this passkey is for {step['origin']}, so nothing "
                              "was clicked.")
            self.client.call("WebAuthn.enable", {"enableUI": False}, session_id=self.session)
            # No user verification: nothing here verifies a person, so a site that requires it is
            # refused by the browser before anything is created or used.
            self.authenticator = self.client.call("WebAuthn.addVirtualAuthenticator", {"options": {
                "protocol": "ctap2", "transport": "internal", "hasResidentKey": True,
                "hasUserVerification": False, "isUserVerified": False,
                "automaticPresenceSimulation": False}}, session_id=self.session)["authenticatorId"]
            credential = step.get("credential")
            if credential:
                self.call("WebAuthn.addCredential", {"credential": {
                    # Discoverable only with its user handle, which the browser requires of one.
                    "credentialId": credential["credentialId"],
                    "isResidentCredential": bool(credential.get("userHandle")),
                    "rpId": step["rpId"], "privateKey": credential["privateKey"],
                    **({"userHandle": credential["userHandle"]} if credential.get("userHandle") else {}),
                    "signCount": credential["signCount"]}})
        except BaseException:
            self.close()
            raise

    def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        return self.client.call(method, {"authenticatorId": self.authenticator, **(params or {})},
                                session_id=self.session)

    def credentials(self) -> list[dict[str, Any]]:
        return self.call("WebAuthn.getCredentials").get("credentials") or []

    def present(self) -> None:
        """A person is present from now on: called just before the click."""
        self.call("WebAuthn.setAutomaticPresenceSimulation", {"enabled": True})

    def wait(self) -> dict[str, Any] | None:
        """After the click: the passkey the site created, or for a sign-in whether it was used.
        Raises PasskeyNotTaken when the site did neither in time."""
        before = self.step.get("credential", {}).get("signCount")
        deadline = time.monotonic() + PASSKEY_WAIT_SECONDS
        while True:
            found = self.credentials()
            if before is None and found:
                created = found[0]
                # The browser already holds a site to its own domain; checked again here all the same.
                host, rp_id = urlsplit(self.step["origin"]).hostname or "", str(created.get("rpId") or "")
                if not rp_id or (host != rp_id and not host.endswith("." + rp_id)):
                    raise PasskeyNotTaken("The site created a passkey for another site, so none was saved.")
                return {key: created[key] for key in ("credentialId", "privateKey", "rpId", "userHandle")
                        if created.get(key)}
            if before is not None and any(entry.get("signCount", 0) > before for entry in found):
                return None
            if time.monotonic() >= deadline:
                raise PasskeyNotTaken(PASSKEY_NOT_USED if before is not None else PASSKEY_NOT_CREATED)
            time.sleep(0.1)

    def close(self) -> None:
        try:
            if self.authenticator:
                self.call("WebAuthn.removeVirtualAuthenticator")
        except Exception:  # noqa: BLE001
            pass  # Closing the connection removes it as well.
        finally:
            self.authenticator = None
            self.client.close()

    def __enter__(self) -> "Passkey":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()
