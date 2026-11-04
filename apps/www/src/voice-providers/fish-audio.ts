import type { VoiceProvider } from "./types";
import { VOICE_DOC, VOICE_MODELS_DOC, homepage } from "./shared";

export const fishAudio: VoiceProvider = {
  slug: "fish-audio",
  name: "Fish Audio",
  does: "Speaks and transcribes",
  runs: "Hosted",
  bestFor: "Expressive voices and your own cloned voice",
  title: "Fish Audio for AI agents: expressive voices, cloning and transcription",
  description:
    "How to use the Fish Audio API to give AI agents a voice in Rakazo: pick from your cloned voices or Fish Audio's public library, hear replies, talk by voice and call your bots. Limits and setup.",
  h1: "Give your AI agents a Fish Audio voice",
  intro: [
    "[Fish Audio](https://fish.audio) is a hosted voice platform for text to speech, voice cloning and speech to text. It has a large library of voices that its users have published, and you can clone a voice of your own from a short recording. Everything it does in the app is also available through its API.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and you can also talk to it by voice: hold the mic to speak, have replies read aloud, or call a bot in real time. With a Fish Audio key, your bots speak in a Fish Audio voice and Fish Audio turns what you say into text.",
  ],
  scene: {
    bot: "Chief of Staff",
    color: "#3EC5A8",
    where: "Voice from Fish Audio",
    ask: "call me at 5 to go over the day",
    reply: "will do. i'll ring you at 5.",
    results: [
      { k: "Voice", v: "Your cloned voice, from Fish Audio" },
      { k: "Call", v: "4 min, transcript in chat" },
      { k: "Heard", v: "Your answers, transcribed by Fish Audio" },
    ],
  },
  sections: [
    {
      heading: "What is Fish Audio?",
      paragraphs: [
        "Fish Audio offers three things that matter to an AI agent: speech, cloning and transcription. Its speech models turn text into audio in a chosen voice, and its [documentation](https://docs.fish.audio) recommends `s2.1-pro` for production. Its transcription model, `transcribe-1-pro`, handles several languages and multiple speakers.",
        "Every voice is a model in your Fish Audio account or in its public library. Clone one from a clip in the Fish Audio app and it becomes a voice your API key can use.",
      ],
      image: true,
    },
    {
      heading: "What you can do with Fish Audio in Rakazo",
      paragraphs: [
        "Fish Audio both speaks and transcribes, so one key covers every voice feature. The [voice and calls guide](/docs/voice-and-calls/) walks through each one.",
      ],
      bullets: [
        "Talk instead of typing. Hold the mic in the composer and speak; Fish Audio transcribes it and the bot gets your message.",
        "Hear replies. Choose **Speak this reply** on any message, or turn on **Read replies aloud** in a bot's settings to hear every reply in its voice.",
        "Call a bot. Choose **Call** at the top of the chat to talk in real time. The transcript stays in the chat afterwards.",
        "Let bots call you. Ask \"call me at 5 to go over the day\", and the bot rings you at five.",
        "Give each bot its own voice. The **Voice** picker lists your own Fish Audio voices first, including ones you cloned, then popular public voices. A bot's settings can override your default.",
      ],
    },
    {
      heading: "When to choose Fish Audio",
      paragraphs: [
        "Choose Fish Audio when the voice itself matters: a cloned voice, an unusual character, or a language where you want more choice than a fixed set of voices gives you. It speaks and transcribes, so one account does both.",
        "[ElevenLabs](/voice-providers/elevenlabs/) is the other choice for cloning and polished voices. [OpenAI](/voice-providers/openai/) is simplest if you already have a key, and [Cartesia](/voice-providers/cartesia/) is built for low-latency speech but does not transcribe. To keep voice off hosted services entirely, run a [self-hosted speech server](/voice-providers/self-hosted/), or use the [voices built into a Mac](/voice-providers/macos/) when Rakazo runs on one. The [voice provider comparison](/voice-providers/) puts all six side by side.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        "Fish Audio is a hosted service. The text your bots speak and the audio you record are sent to it, and use comes out of your Fish Audio account. Its free plan is for personal use only.",
        "Rakazo asks Fish Audio for each reply as a finished clip. It doesn't use Fish Audio's realtime streaming API.",
        "The voice picker shows your own voices and the top public voices, not the whole library.",
        "When your Fish Audio credit runs out or the key is rejected, speaking and transcribing stop until you fix the account.",
        "On the mobile app, calls can use your phone's own voices if you pick a **Device voice** in the bot's settings. Otherwise replies use this provider.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "Each person connects their own key in the app, on Rakazo Cloud or a [self-hosted Rakazo](/self-hosted-ai-agent/). A space can use different voice settings from the rest of your account.",
      ],
      steps: [
        "Create an API key in your Fish Audio account. To use your own voice, clone it in the Fish Audio app first.",
        "In Rakazo, open **Settings → Voice**, set **Provider** to **Fish Audio** and paste the key.",
        "Pick a **Voice**, then choose **Hear a sample** to check it.",
        "Optionally enter a **Speech model** to use a Fish Audio model other than the default `s2.1-pro`.",
        "If you host Rakazo yourself, set `PHONE_CALLS_ENABLED=true` on the API and worker to turn on hold-to-talk and calls. Server admins can change the defaults with `FISH_TTS_MODEL` and `FISH_ASR_MODEL`.",
      ],
    },
  ],
  image: homepage(
    "fish-audio",
    "Fish Audio",
    "The Fish Audio homepage, headed The most expressive, emotionally controllable real-time voice model.",
  ),
  faq: [
    {
      question: "Can I use a cloned Fish Audio voice for my AI agent?",
      answer:
        "Yes. Clone the voice in your Fish Audio account, then pick it from the **Voice** list in Rakazo's voice settings. Your own voices are listed before public ones.",
    },
    {
      question: "Does the Fish Audio API do speech to text?",
      answer:
        "Yes. Rakazo uses it to transcribe what you say when you hold the mic or talk on a call, with `transcribe-1-pro` by default.",
    },
    {
      question: "Which Fish Audio model does Rakazo use?",
      answer:
        "`s2.1-pro` for speech and `transcribe-1-pro` for transcription. You can enter another speech model in **Settings → Voice**, and a self-hosted server can change both defaults.",
    },
    {
      question: "Do I need a Fish Audio account?",
      answer:
        "Yes, Fish Audio needs its own API key. If you don't want a hosted voice account, use a self-hosted speech server or, when Rakazo runs on a Mac, the Mac's built-in voices.",
    },
  ],
  sources: [
    { label: "Fish Audio", href: "https://fish.audio" },
    { label: "Fish Audio documentation", href: "https://docs.fish.audio" },
    VOICE_DOC,
    VOICE_MODELS_DOC,
  ],
};
