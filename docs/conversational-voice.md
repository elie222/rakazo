# Conversational voice

The optional conversational provider streams microphone audio and replies over WebRTC. The API authenticates the connection and keeps the provider key on the server. Existing bot models, tools, approvals, dictation, and other voice connections remain available.

## Configure later

No API key is included or required to build. The existing **Voice settings → API key** field is intentionally left empty. Once this version is installed, choose the conversational provider, paste your own provider API key into that field, connect, and choose its voice. Never add the key to source code or a frontend environment variable.

On mobile, disable the device-only voice preference to use the connected provider. Start a call from a bot's conversation. Microphone access and AI processing consent are requested when needed. Mute and hang-up stop microphone capture; ending a call saves the timed transcript to its call card. Provider transcript timing is not proof that every word was heard.

The bot's configured text model handles delegated facts, reasoning, and tools. Voice does not override its reasoning setting. Approval requests stay in the chat. Ending a call stops audio, but an already-started bot task can continue in the chat.

## Release checks

- Deploy matching API and web builds; desktop hosts the web UI.
- Build a new native mobile binary with the WebRTC module. An over-the-air JavaScript update or Expo Go alone is insufficient.
- Add the key through Voice settings and verify provider model access and billing.
- Verify two-way audio, interruptions, mute, hang-up, incoming-call opening, reconnection, and transcript persistence on actual browsers and phones.
- Test mobile interactions with ARTEMIS on an authorized device before adding device UI tests.

Calls have a 30-minute duration limit and a bounded transcript. There is no automatic reconnect or replay of a disconnected call. Live audio quality and native compatibility remain unverified until the release checks above are performed.

## Android speaker routing

Live calls start on the loudspeaker. Once connected, the call card's **Speaker on/off** button switches between the built-in loudspeaker and earpiece. A rejected route leaves the selection unchanged and shows an error; tablets without an earpiece can keep using the speaker. This control is for live calls on Android, not message read-aloud or iOS. Hang-up and failed connections release the communication route and restore the previous audio mode. This native change requires a new APK.

The Android implementation uses `AudioManager.setCommunicationDevice` on Android 12 and later, and the legacy speakerphone API on earlier supported versions. It explicitly selects built-in outputs; it is not a Bluetooth/headset device picker. Verify routing, volume, interruptions and cleanup on the target phone before treating a build as device-tested.
