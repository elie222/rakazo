#!/usr/bin/env python3
"""Import grok-bot agent profiles into a running Rakazo instance."""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "http://127.0.0.1:3100"
ORIGIN = "http://127.0.0.1:5173"
IMPORT = Path.home() / "src" / "rakazo-import"
CREDS = Path.home() / ".config" / "rakazo" / "admin.txt"
DESC_MAX = 4000
INST_MAX = 20000
NAME_MAX = 80
TITLE_MAX = 500

# grok sidebar order (pinned first, then sections)
PINNED = [
    "0059456e-9952-4bf6-bc35-fd8e7186f681",  # general
    "1e488ecf-c613-41cc-b7e7-b444677f56c7",  # Content Summarizer
    "f7037574-7c15-4a51-a78e-157fbf63baba",  # Signal Monitor
    "40bc8583-99c9-444b-ba1b-affbf3eb5a46",  # Tesla Concierge
]
SECTIONS = [
    ("Travail / Perso", ["006016ef-882e-4c6f-853b-2fcd685b9cc6", "731ee068-71c8-4d57-9cba-a8a73cfeb4c4"]),
    ("QScale Specific", ["26954552-0be0-4e01-bc27-f504023bb209", "66e98464-01eb-48f4-a6dc-84e32688b267", "c41a1a19-1a1d-4405-ae5d-eddcfd0c863d"]),
    ("Perso Trackers", ["512277ee-fe23-4b1c-b212-384d693527d1", "97d60507-9b37-4617-bc50-3de417b76cc1"]),
    ("Voyage", ["9afc3476-9117-42c1-9e34-19547e27ba33", "2b6fc76d-b65d-4ec0-b2ec-3656e4d1b2e7"]),
    ("Résidences", ["78a5939f-8542-4cc8-aecf-fdf1fc599bf7"]),
    ("New section", ["e838cb8e-25fc-4b35-bd59-6a3511112d50"]),
]


def load_creds() -> dict[str, str]:
    out: dict[str, str] = {}
    for line in CREDS.read_text().splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def strip_wrap(s: str) -> str:
    s = (s or "").strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        s = s[1:-1]
    return s.strip()


def http(method: str, url: str, body: dict | None = None, cookie: str | None = None) -> tuple[int, dict | str, str]:
    data = None if body is None else json.dumps(body).encode()
    headers = {
        "content-type": "application/json",
        "origin": ORIGIN,
        "user-agent": "rakazo-import/1",
    }
    if cookie:
        headers["cookie"] = cookie
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            raw = res.read().decode()
            set_cookie = res.headers.get("set-cookie") or ""
            try:
                parsed = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                parsed = raw
            return res.status, parsed, set_cookie
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            parsed = json.loads(raw) if raw else {"error": raw}
        except json.JSONDecodeError:
            parsed = raw
        return e.code, parsed, e.headers.get("set-cookie") or ""


def rpc(cookie: str, proc: str, body: dict | None = None):
    status, parsed, _ = http("POST", f"{API}/rpc/{proc}", {"json": body or {}}, cookie)
    if isinstance(parsed, dict) and parsed.get("error"):
        raise RuntimeError(f"{proc} {status}: {parsed['error']}")
    if status >= 400:
        raise RuntimeError(f"{proc} {status}: {parsed}")
    if isinstance(parsed, dict) and "json" in parsed:
        return parsed["json"]
    return parsed


def cookie_from(set_cookie: str) -> str:
    # keep better-auth.session_token=...
    parts = []
    for chunk in set_cookie.split(","):
        first = chunk.split(";")[0].strip()
        if first.lower().startswith("better-auth.session_token="):
            parts.append(first)
    return "; ".join(parts) if parts else set_cookie.split(";")[0].strip()


def memory_text(agent_dir: Path, name: str) -> str:
    chunks = [f"# {name}\n"]
    profile = agent_dir / "memory" / "profile.md"
    if profile.exists():
        chunks.append(profile.read_text())
    log = agent_dir / "memory" / "log" / "2026-08.md"
    if log.exists():
        chunks.append("\n\n# Activity log\n\n" + log.read_text())
    um = IMPORT / "user-memory" / "by-agent" / agent_dir.name / "profile.md"
    if um.exists():
        extra = um.read_text().strip()
        if extra and extra not in "".join(chunks):
            chunks.append("\n\n# Shared user memory\n\n" + extra)
    return "\n".join(chunks).strip() + "\n"


def main() -> None:
    creds = load_creds()
    email = creds["email"]
    password = creds["password"]
    name = creds.get("name", "Admin")

    status, parsed, set_cookie = http(
        "POST",
        f"{API}/api/auth/sign-up/email",
        {"email": email, "password": password, "name": name},
    )
    if status >= 400:
        status, parsed, set_cookie = http(
            "POST",
            f"{API}/api/auth/sign-in/email",
            {"email": email, "password": password},
        )
        if status >= 400:
            raise SystemExit(f"auth failed {status}: {parsed}")
    cookie = cookie_from(set_cookie)
    if not cookie:
        raise SystemExit("no session cookie")

    me = rpc(cookie, "me", {})
    print("signed in as", me.get("user", {}).get("email") if isinstance(me, dict) else me)

    existing = {b["name"]: b for b in rpc(cookie, "bots/list", {})}
    created: dict[str, dict] = {}
    agents_root = IMPORT / "agents"
    agent_ids = [d.name for d in agents_root.iterdir() if (d / "profile.json").exists()]
    # create pinned first so they stay near the top, then the rest
    ordered = [i for i in PINNED if i in agent_ids] + [i for i in agent_ids if i not in PINNED]

    for grok_id in ordered:
        agent_dir = agents_root / grok_id
        profile = json.loads((agent_dir / "profile.json").read_text())
        bot_name = strip_wrap(profile.get("name") or grok_id)[:NAME_MAX]
        title = strip_wrap(profile.get("title") or "")[:TITLE_MAX]
        description = strip_wrap(profile.get("description") or "")
        instructions = description[:INST_MAX]
        description = description[:DESC_MAX]
        payload = {
            "name": bot_name,
            "title": title,
            "description": description,
            "instructions": instructions,
            "notifyOnFinish": True,
            "computerMode": "team",
        }
        if bot_name in existing:
            bot = existing[bot_name]
            rpc(cookie, "bots/update", {"botId": bot["id"], **{k: payload[k] for k in ("name", "title", "description", "instructions", "notifyOnFinish")}})
            bot = rpc(cookie, "bots/get", {"botId": bot["id"]})
            print("updated", bot_name)
        else:
            bot = rpc(cookie, "bots/create", payload)
            print("created", bot_name, bot["id"])
        created[grok_id] = bot

        pin = grok_id in PINNED
        if bot.get("pinned") != pin:
            rpc(cookie, "bots/update", {"botId": bot["id"], "pinned": pin})

        # memory
        docs = rpc(cookie, "memory/list", {"botId": bot["id"], "scope": "bot"})
        mem_doc = next((d for d in docs if d.get("path") == "MEMORY.md"), docs[0] if docs else None)
        content = memory_text(agent_dir, bot_name)
        autos = agent_dir / "automations"
        webhook_bits = []
        cron_count = 0
        if autos.exists():
            for auto_dir in sorted(p for p in autos.iterdir() if p.is_dir()):
                aj = auto_dir / "automation.json"
                if not aj.exists():
                    continue
                auto = json.loads(aj.read_text())
                rname = (auto.get("name") or auto_dir.name)[:80]
                prompt = auto.get("prompt") or ""
                schedule = auto.get("schedule")
                trigger = (auto.get("trigger") or {}) if isinstance(auto.get("trigger"), dict) else {}
                if not schedule:
                    schedule = (auto.get("triggerPresentation") or {}).get("trigger", {}).get("schedule")
                if schedule and prompt:
                    try:
                        rpc(
                            cookie,
                            "routines/create",
                            {
                                "botId": bot["id"],
                                "name": rname,
                                "prompt": prompt,
                                "cron": schedule,
                                "timezone": "America/Toronto",
                                "notify": True,
                                "active": bool(auto.get("enabled", True)),
                            },
                        )
                        cron_count += 1
                    except RuntimeError as e:
                        if "already" in str(e).lower() or "unique" in str(e).lower():
                            pass
                        else:
                            print("routine fail", rname, e)
                else:
                    webhook_bits.append(f"## {rname} ({trigger.get('type') or 'non-cron'})\n\n{prompt}")
        if webhook_bits:
            content += "\n\n# Imported non-cron automations\n\n" + "\n\n".join(webhook_bits) + "\n"
        if mem_doc:
            rpc(cookie, "memory/update", {"documentId": mem_doc["id"], "content": content})
        print(f"  memory {len(content)} chars, routines {cron_count}")

    # sections
    section_ids: dict[str, str] = {}
    for section_name, members in SECTIONS:
        first = next((created[i] for i in members if i in created), None)
        if not first:
            continue
        existing_sections = {s["name"]: s for s in rpc(cookie, "botSections/list", {})}
        if section_name in existing_sections:
            section_ids[section_name] = existing_sections[section_name]["id"]
        else:
            sec = rpc(cookie, "botSections/create", {"botId": first["id"], "name": section_name})
            section_ids[section_name] = sec["id"]
            print("section", section_name, sec["id"])
        sid = section_ids[section_name]
        for grok_id in members:
            bot = created.get(grok_id)
            if not bot:
                continue
            if bot.get("sectionId") != sid:
                rpc(cookie, "bots/update", {"botId": bot["id"], "sectionId": sid})

    # user memory
    user_docs = rpc(cookie, "memory/list", {"scope": "user"})
    user_mem = next((d for d in user_docs if d.get("path") == "MEMORY.md"), user_docs[0] if user_docs else None)
    um_bits = ["# User memory\n", "Imported from grok-bot. Timezone America/Toronto.\n"]
    um_root = IMPORT / "user-memory"
    if um_root.exists():
        for f in sorted(um_root.rglob("*.md")):
            rel = f.relative_to(um_root)
            um_bits.append(f"\n## {rel}\n\n" + f.read_text())
    if user_mem:
        rpc(cookie, "memory/update", {"documentId": user_mem["id"], "content": "\n".join(um_bits)})

    final = rpc(cookie, "bots/list", {})
    print("BOT_COUNT", len(final))
    for b in final:
        print(f"  {'*' if b.get('pinned') else ' '} {b['name']} {b['id']}")

    # ping a cheap bot to prove DeepSeek replies
    target = next((b for b in final if b["name"] == "Elon"), final[0])
    send = rpc(cookie, "threads/send", {"botId": target["id"], "text": "Reply with exactly the single word: pong"})
    print("sent", target["name"], send)
    deadline = time.time() + 120
    seen = ""
    while time.time() < deadline:
        page = rpc(cookie, "threads/messages", {"botId": target["id"]})
        messages = page if isinstance(page, list) else page.get("messages") or page.get("items") or []
        texts = []
        for m in messages:
            role = m.get("role") or m.get("author") or ""
            blocks = m.get("blocks") or []
            text = m.get("text") or ""
            if blocks:
                text = " ".join(
                    (b.get("text") or b.get("content") or "") if isinstance(b, dict) else str(b)
                    for b in blocks
                )
            texts.append(f"{role}:{text}")
        blob = "\n".join(texts)
        if "pong" in blob.lower() and ("bot" in blob.lower() or "assistant" in blob.lower()):
            print("REPLY_OK")
            print(blob[-800:])
            return
        seen = blob
        time.sleep(3)
    print("REPLY_TIMEOUT last=", seen[-1200:])


if __name__ == "__main__":
    main()
