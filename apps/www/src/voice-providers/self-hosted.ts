import type { VoiceProvider } from "./types";
import { VOICE_DOC, VOICE_MODELS_DOC, homepage } from "./shared";

export const selfHosted: VoiceProvider = {
  slug: "self-hosted",
  name: "Self-hosted voice",
  does: "Speaks and transcribes, if your server does",
  runs: "Your server",
  bestFor: "Private, offline voice with no vendor account",
  title: "Self-hosted voice for AI agents: Kokoro, Whisper and any OpenAI-compatible speech server",
  description:
    "Run text to speech and speech to text for your AI agents on your own hardware. Connect Kokoro, Whisper or any OpenAI-compatible speech server to Rakazo, with no hosted voice vendor. Limits, network rules and setup.",
  h1: "Self-hosted voice for your AI agents",
  intro: [
    "You don't need a voice vendor to talk to an AI agent. Open models such as [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) for speech and Whisper for transcription run on an ordinary computer, and several open source servers put them behind the same API shape OpenAI uses. Point an agent at that server and no voice vendor ever hears you. The finished audio still goes to whichever device is listening.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and you can also talk to it by voice: hold the mic to speak, have replies read aloud, or call a bot in real time. Its **Self-hosted** voice option connects to any OpenAI-compatible speech server you run, so a [self-hosted Rakazo](/self-hosted-ai-agent/) can have voice with no hosted service at all.",
  ],
  scene: {
    bot: "Inbox Manager",
    color: "#6A6BF5",
    where: "Voice from your own server",
    ask: "read me what came in overnight",
    reply: "three things need you. reading them now.",
    results: [
      { k: "Speech", v: "Kokoro on your server" },
      { k: "Transcription", v: "Whisper on your server" },
      { k: "Voice vendor", v: "None, your own server" },
    ],
  },
  sections: [
    {
      heading: "What is a self-hosted speech server?",
      paragraphs: [
        "It's a small web service on a machine you control that answers OpenAI's audio API: `POST /v1/audio/speech` turns text into audio and `POST /v1/audio/transcriptions` turns audio into text. Because the shape is shared, one client works with many servers and models.",
        "[Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) serves the Apache-licensed Kokoro-82M model and only speaks. [Speaches](https://github.com/speaches-ai/speaches) does both, with faster-whisper for transcription and Kokoro or Piper for speech. [mlx-audio](https://github.com/Blaizzy/mlx-audio) runs Kokoro and Whisper on Apple Silicon. Rakazo's default model names match mlx-audio's.",
      ],
      image: true,
    },
    {
      heading: "What you can do with self-hosted voice in Rakazo",
      paragraphs: [
        "Rakazo sends both speech and transcription to the one **Server URL** you enter. If that server does both, you get every voice feature in the [voice and calls guide](/docs/voice-and-calls/).",
      ],
      bullets: [
        "Talk instead of typing. Hold the mic in the composer and your server transcribes what you say.",
        "Hear replies. Choose **Speak this reply** on a message, or turn on **Read replies aloud** in a bot's settings.",
        "Call a bot with **Call** at the top of the chat, or let a bot call you, for example when you ask it to call you at 5.",
        "Pick a voice from the server's own list. Kokoro voices show their language, and Rakazo passes that language to the server so a French voice reads with French pronunciation.",
      ],
    },
    {
      heading: "When to choose self-hosted voice",
      paragraphs: [
        "Choose it when you don't want a hosted vendor to process your voice, when you want voice with no vendor account, or when you already run local models. It pairs naturally with a [self-hosted Rakazo](/self-hosted-ai-agent/) and a local model, so the whole assistant can work offline.",
        "Hosted providers are less work and usually sound more polished. [ElevenLabs](/voice-providers/elevenlabs/) and [Fish Audio](/voice-providers/fish-audio/) offer cloning, [OpenAI](/voice-providers/openai/) reuses a key you may already have, and [Cartesia](/voice-providers/cartesia/) is tuned for low latency. If Rakazo runs directly on a Mac, [macOS voices](/voice-providers/macos/) speak with nothing to install, but don't transcribe. See the [comparison](/voice-providers/) for all six.",
      ],
    },
    {
      heading: "Limits and network rules",
      bullets: [
        "Quality and speed depend on your models and hardware. Whisper on a CPU can be slow on a call.",
        "A speech-only server such as Kokoro-FastAPI can't transcribe. Use a server that does both if you want to hold the mic or make calls.",
        "Addresses on your own network, `localhost` and `host.docker.internal` are refused unless the server sets `MCP_ALLOW_PRIVATE_ENDPOINT=true` on the API and worker. That setting applies to every user, so leave it off on a public install.",
        "A hostname that resolves to a private address must also be listed in `RAKAZO_OPENAI_COMPAT_PRIVATE_HOSTS`. Cloud metadata and link-local addresses are always blocked.",
        "A public address must use HTTPS if you add an API key. Setting `RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC=0` blocks public servers, and hides the option if private ones aren't allowed either.",
        "On the mobile app, calls can use your phone's own voices if you pick a **Device voice** in the bot's settings. Otherwise replies use this provider.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "Whoever runs the Rakazo server allows the address once; then each person connects in the app. The [self-hosted model settings](/docs/self-host-models/) cover the network options in full.",
      ],
      steps: [
        "Start a speech server, for example the Kokoro-FastAPI Docker image, Speaches, or `mlx_audio.server` on a Mac.",
        "On the Rakazo API and worker, set `MCP_ALLOW_PRIVATE_ENDPOINT=true` for a server on your network, and `PHONE_CALLS_ENABLED=true` to turn on hold-to-talk and calls. Restart them.",
        "Open **Settings → Voice**, set **Provider** to **Self-hosted** and enter the **Server URL**, such as `http://192.168.1.10:8880/v1`. Rakazo adds `/v1` if you leave it off. If Rakazo runs in Docker and the speech server is on the same machine, use `host.docker.internal` instead of `localhost`.",
        "Add an **API key** only if your server needs one. Change **Speech model** and **Transcription model** if your server uses other names; Kokoro-FastAPI expects `kokoro`.",
        "Choose **Connect**, pick a **Voice** and choose **Hear a sample**.",
      ],
    },
  ],
  image: {
    ...homepage(
      "self-hosted",
      "Kokoro-FastAPI",
      "The Kokoro-FastAPI GitHub repository, described as a Dockerized OpenAI-compatible wrapper for Kokoro-82M text-to-speech.",
    ),
    caption: "Kokoro-FastAPI, one OpenAI-compatible speech server.",
  },
  faq: [
    {
      question: "Can I use Kokoro TTS with an AI agent?",
      answer:
        "Yes. Run Kokoro behind an OpenAI-compatible server such as Kokoro-FastAPI, Speaches or mlx-audio, then enter its URL under **Self-hosted** in Rakazo's voice settings. Rakazo lists the Kokoro voices and reads replies with the one you pick.",
    },
    {
      question: "Can I use a local Whisper server for speech to text?",
      answer:
        "Yes, if it answers `/v1/audio/transcriptions` the way OpenAI does. Speaches and mlx-audio both do. Set **Transcription model** to the model name your server expects.",
    },
    {
      question: "Does self-hosted voice work offline?",
      answer:
        "Voice does: speech and transcription go only to your server. For a fully offline assistant, also self-host Rakazo and use a local language model.",
    },
    {
      question: "Why can't Rakazo reach my speech server on localhost?",
      answer:
        "Private addresses are refused until the server sets `MCP_ALLOW_PRIVATE_ENDPOINT=true` on the API and worker. If Rakazo runs in Docker, `localhost` is the container itself, so use `host.docker.internal` or the machine's network address.",
    },
  ],
  sources: [
    { label: "Kokoro-FastAPI", href: "https://github.com/remsky/Kokoro-FastAPI" },
    { label: "Kokoro-82M model", href: "https://huggingface.co/hexgrad/Kokoro-82M" },
    { label: "Speaches", href: "https://github.com/speaches-ai/speaches" },
    { label: "mlx-audio", href: "https://github.com/Blaizzy/mlx-audio" },
    VOICE_DOC,
    VOICE_MODELS_DOC,
  ],
};
