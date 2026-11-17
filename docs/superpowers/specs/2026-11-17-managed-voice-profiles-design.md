# Managed Voice Profiles Design

## Goal

Make a bot's effective voice configuration visible and durable without embedding private voice
identifiers or character-specific rules in Rakazo's public source tree.

## Decisions

- A private `managed-voice-profiles.json` file is the single source of truth.
- Rakazo loads the file once during API startup from `DATA_DIR`.
- A missing file means the feature is unused. A present but invalid file stops startup rather than
  silently falling back to another voice.
- Managed profiles are read-only in the bot panel. The normal picker remains unchanged for bots
  without a profile.
- The API rejects voice-selection writes for managed bots, including writes from older clients.
- Synthesis uses the managed profile directly. It does not mirror profile values into the Bot row.
- The public repository contains only provider-neutral plumbing and validation. The production file,
  bot ids, voice ids, labels, models and tuning values remain outside Git.

## Private file format

```json
{
  "version": 1,
  "profiles": [
    {
      "botId": "c000000000000000000000000",
      "voiceId": "connection::private-voice-id",
      "voiceLabel": "Private voice",
      "model": "speech-model",
      "settings": {
        "speed": 0.94
      }
    }
  ]
}
```

Every profile is locked. `model` and `settings` are optional. The connection prefix in `voiceId`
selects the already-connected account credential; no key is stored in this file.

## Runtime flow

1. API startup loads and validates `${DATA_DIR}/managed-voice-profiles.json`.
2. The bot panel asks for the signed-in user's managed profile for the selected bot.
3. The API verifies that the bot belongs to the current Space before returning profile metadata.
4. The Voice section disables only the voice picker and progressively reveals model and tuning
   details. Read-aloud remains editable.
5. Speech synthesis resolves the managed qualified voice before the saved Bot voice.
6. The selected adapter validates its own settings and translates them into its upstream request.

## Failure and safety behavior

- Unknown file fields, malformed ids, duplicate bot ids, oversized settings or invalid JSON fail
  startup with a path-specific error.
- A managed profile whose connection is not configured fails speech with the existing
  `NoVoiceConfigured` path. It never falls back to the account default.
- Adapters reject unsupported or out-of-range managed settings before sending a network request.
- The UI never receives API keys or the server file path.
- Deployments without the private file behave exactly as before.

## Production persistence

The host keeps the real file at `/opt/rakazo/private/managed-voice-profiles.json`. The existing
Compose override mounts it read-only at `/data/managed-voice-profiles.json`. Image replacement and
container recreation therefore keep the same voice profiles, while the file remains inspectable on
the host and outside the public repository.

## Verification

- Parser tests cover absent, valid, duplicate and malformed files.
- API tests prove managed synthesis overrides Bot state and never falls back.
- route tests prove Space isolation and locked voice updates.
- adapter tests prove settings translation and validation.
- web tests prove the details are visible and the picker is disabled only for managed bots.
- a production smoke check verifies the loaded profile, exact upstream request shape and rollback.
