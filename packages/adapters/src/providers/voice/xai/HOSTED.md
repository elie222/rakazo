# Hosted voice provider selection (researched 2026-11-17)

Reuse the existing xAI adapter as the initial calibration candidate. No new voice vendor,
subscription or realtime reasoning engine is required. Use `provider: "xai"`, `voiceId: "eve"`,
`connection.plaintext: "FAKE_SERVER_API_KEY"`, `synthesize.model: "tts"` at 15 micros/character,
and `transcribe.model: "grok-voice-transcribe-2.0"` at 27.77777777777778 micros/second.
`tts` identifies this adapter's unversioned speech endpoint, not a reasoning model. Copy the generic
configuration shape from `docs/deployment-voice.md`, replace pricing source URLs with the two xAI
pricing pages below, and choose reservation amounts and grants under approved policy. These are
list-price estimates; actual charges require reconciliation. No promotion is assumed.

Official sources:

- [xAI speech pricing](https://docs.x.ai/developers/models/text-to-speech): $15/million characters.
- [xAI recognition pricing](https://docs.x.ai/developers/models/speech-to-text): REST $0.10/hour;
  streaming $0.20/hour. The existing adapter uses REST. It advertises interim results, automatic
  language detection and Smart Turn for streaming, which are not enabled by this change.
- [xAI speech guide](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech): supports
  expressive voices, MP3 and streaming with configurable first-chunk latency/quality tradeoffs.
- [xAI recognition response](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text):
  reports duration in seconds; the adapter persists it as billable-unit evidence.

- Historical comparison only (deprecated): [TTS-1](https://developers.openai.com/api/docs/models/tts-1): $15/million characters.
- Historical comparison only (deprecated): [Whisper](https://developers.openai.com/api/docs/models/whisper-1): $0.006/minute.
- [Audio pricing](https://developers.openai.com/api/docs/pricing): mini transcription approximately
  $0.003/minute and mini TTS approximately $0.015/minute. These minute figures are estimates of
  token billing, not a uniform per-minute invoice tariff. Do not use them as confirmed costs.
- [Speech guide](https://developers.openai.com/api/docs/guides/text-to-speech): TTS-1 favors lower
  latency over HD quality; mini TTS offers expressive control and recommends marin/cedar for quality.
  Voice availability differs by model. Streaming audio is supported; WAV/PCM avoids MP3 decoding.
- [Cloudflare pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/): Whisper and
  Whisper turbo $0.0005/minute; MeloTTS $0.0002/minute; Aura-1 $0.015/1,000 characters;
  Aura-2 $0.030/1,000 characters; Nova-3 $0.0052/minute ($0.0092 WebSocket).

Use normal paid rates for planning. The expiring promotional balance is not a permanent subsidy.
Cloudflare's low rates merit a later quality/compatibility trial, but a new gateway/provider is not
needed for the first change. Do not assume the existing compatible speech server adapter can call
all Workers AI model endpoints. Protocol support, returned billable usage and voices must be
verified before routing production there. The existing providers also allow operator-run compatible
speech servers; include compute, maintenance and capacity in that comparison.

Do not choose the existing OpenAI Speech API models as a sustainable new deployment dependency:
[official deprecations](https://developers.openai.com/api/docs/deprecations) schedule Speech API
models for shutdown January 6, 2027 and legacy transcription models February 26, 2027. Their
recommended realtime replacements would need separate protocol work; this change does not
replace the normal reasoning run with a provider's conversation engine. The adapter's character/
duration evidence is retained for existing configurations while those endpoints remain available.

The initial xAI choice needs human quality review; no live latency measurement or audio quality
ranking has been run. The adapter records input characters and returned duration, along with
provider request IDs when supplied. Rate calculations remain estimates pending provider billing
exports, including rounding and Unicode counting. Accounts with absent usage keep their full
reservation. Token-billed operations on any adapter remain unresolved pending evidence import.

Before enabling hosted traffic, use synthetic/consented examples on the operator's staging key:

1. Human-review English and supported non-English accents, names, noise, silence, numbers,
   short interjections and long sentences. Check recognition accuracy and understandable output.
   Any automated semantic judge needs a versioned rubric and reviewed calibration examples;
   do not grade prose with keywords. Keep paid judge cost separate.
2. Measure end-of-utterance to transcript, model first token, first playable audio and end-to-end
   response. Record p50/p95 with device/network class, model and provider configuration. Compare
   the candidate voices and alternative existing adapters before choosing the final default. Use measured gaps to justify a follow-up
   streaming change in the existing session; do not add a second engine.
3. Exercise mute, interruption, hangup during recognition/reasoning/playback, lost connections,
   tools and approval waits, Space switching and late answers. Confirm cancelled work cannot
   play in the next call. Verify mobile native/device speech and server-recognition fallback.
4. Reconcile units and estimated cost against provider billing, including failed/cancelled calls,
   rounding, Unicode character counting, missing usage and rate changes. Provision paid account
   grants only after allowance policy is agreed; ensure model-credit balances stay untouched.

Operator needs: a dedicated server API key with speech access, account spend limits, validated
voices/models, approved allowance policy, grant provisioning/revocation, and an evidence import
for actual provider costs. No production keys were read or used for this implementation.
