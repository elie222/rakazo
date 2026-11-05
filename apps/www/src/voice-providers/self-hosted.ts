import type { VoiceProvider } from "./types";
import {
  PRICING_SOURCES,
  RATES,
  VOICE_DOC,
  VOICE_MODELS_DOC,
  WORKLOAD,
  WORKLOAD_NAMES,
  aboutTotal,
  workloadExtremes,
  homepage,
  speechHourCost,
  usd,
  voicePriceTable,
  voiceWorkloadTable,
  withPricingSources,
} from "./shared";

const WORKLOAD_SHOWN = ["selfHosted", "selfHostedCloud", "openai", "fish", "elevenlabs", "cartesia"] as const;
const COMPARED = ["selfHosted", "hostedKokoro", "macos", "openai", "fish", "elevenlabs"] as const;

/** RunPod RTX 4090 per hour, community and secure, as of November 2026. */
const GPU_HOUR = { low: 0.34, high: 0.89 };
const HOURS_A_MONTH = 24 * 30;
const ELEVENLABS_HOUR = speechHourCost(RATES.elevenlabsFlash);
/** Hours of speech a month at which an always-on GPU costs the same as ElevenLabs Flash v2.5. */
const HOSTED = workloadExtremes();

const GPU_BREAK_EVEN_HOURS = Math.round((GPU_HOUR.low * HOURS_A_MONTH) / ELEVENLABS_HOUR);

export const selfHosted: VoiceProvider = {
  slug: "self-hosted",
  name: "Self-hosted voice",
  does: "Speaks and transcribes, if your server does",
  runs: "Your server",
  bestFor: "Private, offline voice with no vendor account",
  title: "Kokoro TTS and open source text to speech for AI agents: self-hosted voice in 2026",
  description:
    "Run Kokoro, Whisper and other open source text to speech and speech to text models for your AI agents. Licenses, hardware and real costs compared, OpenAI-compatible servers, and how to connect them to Rakazo with no hosted voice vendor.",
  h1: "Self-hosted voice for AI agents: Kokoro, Whisper and open source TTS",
  intro: [
    "You don't need a voice vendor to talk to an AI agent. Open models such as [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) for speech and Whisper for transcription run on an ordinary computer, and several open source servers put them behind the same API shape OpenAI uses. Point an agent at that server and no voice vendor ever hears you. The finished audio still goes to whichever device is listening.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and you can also talk to it by voice: hold the mic to speak, have replies read aloud, or call a bot in real time. Its **Self-hosted** voice option connects to any OpenAI-compatible speech server you run, so a [self-hosted Rakazo](/self-hosted-ai-agent/) can have voice with no hosted service at all.",
    "This page compares the open source speech models people actually run in 2026, their licenses and hardware, what self-hosting costs against hosted APIs, and how to connect a server to Rakazo.",
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
        "[Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) serves the Apache-licensed Kokoro-82M model and only speaks. [Speaches](https://github.com/speaches-ai/speaches) does both, with faster-whisper for transcription and Kokoro or Piper for speech. [mlx-audio](https://github.com/Blaizzy/mlx-audio) runs Kokoro, Whisper and many newer models on Apple Silicon. Rakazo's default model names match mlx-audio's.",
      ],
      image: true,
    },
    {
      heading: "Kokoro TTS",
      paragraphs: [
        "Kokoro-82M is the open model most people start with. It has only 82 million parameters, is licensed Apache 2.0 for commercial use, and ranks close to much larger models on public listening tests. It ships 54 preset voices across American and British English, Spanish, French, Hindi, Italian, Japanese, Brazilian Portuguese and Mandarin; the English voices such as `af_heart` are the strongest. It can't clone a voice, only blend the presets.",
        "It is fast enough for a CPU. Testers report about 6 times faster than real time on an M3 Pro's CPU, under a second to first audio on Apple Silicon, and 35 to 100 times real time on a mid-range NVIDIA GPU, using 2 to 4 GB of memory. On a Raspberry Pi 5 it runs at roughly real time. Kokoro sounds best on sentences of moderate length, which suits Rakazo, since replies are spoken a sentence at a time.",
      ],
    },
    {
      heading: "Best open source text to speech models in 2026",
      paragraphs: [
        "Kokoro is the safe default, but it isn't the only option. The table lists the open models with the most use, what their licenses allow, and whether you can put them behind the OpenAI-shaped API Rakazo talks to. Several of the highest-rated open-weight models are research or non-commercial only, which matters if your bots work for a business.",
      ],
      table: {
        caption: "Open text to speech models, as of November 2026",
        columns: ["Model", "License for the weights", "Size and hardware", "Cloning", "OpenAI-compatible server"],
        rows: [
          {
            topic: "[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)",
            cells: ["Apache 2.0, commercial use", "82M, CPU is fine", "No", "Kokoro-FastAPI, Speaches, mlx-audio"],
          },
          {
            topic: "[Piper](https://github.com/OHF-Voice/piper1-gpl)",
            cells: ["GPL-3.0 code; voices vary", "Tiny, real time on a Pi 4", "No", "Speaches"],
          },
          {
            topic: "[Chatterbox](https://github.com/resemble-ai/chatterbox)",
            cells: ["MIT, every clip watermarked", "110M to 500M, GPU or Apple Silicon", "Yes, from about 10 seconds", "mlx-audio"],
          },
          {
            topic: "[Orpheus](https://github.com/canopyai/Orpheus-TTS)",
            cells: ["Apache 2.0", "3B, a GPU for real time", "Weak", "Community wrappers"],
          },
          {
            topic: "[Dia](https://github.com/nari-labs/dia)",
            cells: ["Apache 2.0", "1.6B, about 4.4 GB of GPU memory", "Yes", "mlx-audio"],
          },
          {
            topic: "[Fish Audio S2-Pro, Drama 3](/voice-providers/fish-audio/)",
            cells: ["Fish Audio license, non-commercial without a paid license", "4B; 35B with 3B active", "Yes", "mlx-audio"],
          },
          {
            topic: "[F5-TTS](https://github.com/SWivid/F5-TTS)",
            cells: ["CC-BY-NC, non-commercial", "GPU", "Yes", "No"],
          },
          {
            topic: "[XTTS-v2](https://huggingface.co/coqui/XTTS-v2)",
            cells: ["Coqui Public Model License, non-commercial; no commercial license is sold", "GPU", "Yes, from 6 seconds", "No"],
          },
        ],
        note: "From each project's README or model card, checked November 2026. Check the license file yourself before commercial use.",
      },
    },
    {
      heading: "Open source speech to text",
      paragraphs: [
        "For transcription, Whisper is still the default. `whisper-large-v3-turbo` (MIT, 809M parameters) is several times faster than large-v3 with similar accuracy in the main languages, and faster-whisper runs it with int8 in about 3 GB of GPU memory. On a CPU, a smaller Whisper model is the practical choice, and short hold-to-talk clips transcribe in a second or two. NVIDIA's Parakeet TDT 0.6B (CC-BY-4.0) is far faster and among the most accurate open models for English and 25 European languages, and runs through mlx-audio on a Mac.",
        "Rakazo sends transcription to the same address as speech, so pick a server that does both: Speaches (faster-whisper with Kokoro or Piper) or mlx-audio on a Mac. Kokoro-FastAPI alone only speaks.",
      ],
    },
    {
      heading: "What self-hosted voice costs",
      paragraphs: [
        "The models are free; you pay for the machine. If Rakazo already runs on a Mac or a PC at home, Kokoro and a small Whisper model fit alongside it and the extra cost is electricity. A dedicated machine for voice ranges from a small rented CPU server to a GPU.",
      ],
      table: {
        caption: "Hardware for a self-hosted speech server, as of November 2026",
        columns: ["Machine", "Cost", "Good for"],
        rows: [
          { topic: "A computer you already own", cells: ["Electricity only", "Kokoro and a small Whisper for one household or team"] },
          {
            topic: "Small cloud CPU server, 4 vCPU and 8 GB",
            cells: [
              `From about ${usd(RATES.cpuServerMonth)} a month (Hetzner, €8.99)`,
              "Kokoro; Whisper is slow on long clips",
            ],
          },
          { topic: "Mac mini", cells: ["From $899 (M6)", "Kokoro and Whisper or Parakeet on mlx-audio, quickly"] },
          {
            topic: "Rented RTX 4090",
            cells: [
              `${usd(GPU_HOUR.low)} to ${usd(GPU_HOUR.high)} an hour, about $${Math.round(GPU_HOUR.low * HOURS_A_MONTH)} to $${Math.round(GPU_HOUR.high * HOURS_A_MONTH)} a month always on`,
              "Many users, larger models such as Chatterbox or Orpheus",
            ],
          },
          { topic: "Rented NVIDIA L4", cells: ["$0.44 to $0.59 an hour", "Same, with less memory"] },
        ],
        note: "From the Hetzner, Apple and RunPod pricing pages, checked November 2026.",
      },
    },
    {
      heading: "Self-hosted vs hosted voice APIs",
      paragraphs: [
        `${WORKLOAD} Hosted, that ranges from ${aboutTotal(HOSTED.cheapest).toLowerCase()} on ${WORKLOAD_NAMES[HOSTED.cheapest]} to ${aboutTotal(HOSTED.dearest).toLowerCase()} on ${WORKLOAD_NAMES[HOSTED.dearest]} a month. Self-hosted on hardware you already have, it costs close to nothing, and on a small rented server about ${usd(RATES.cpuServerMonth)}. A GPU only pays off with many users: at ${usd(GPU_HOUR.low)} an hour, always on, it costs more than ElevenLabs until you generate about ${GPU_BREAK_EVEN_HOURS} hours of speech a month.`,
        "What you give up is polish. The best hosted voices still sound more natural than Kokoro, cloning is easier, and someone else keeps the server running.",
      ],
      table: voiceWorkloadTable("One bot, 30 minutes of speech and 30 of transcription a day", WORKLOAD_SHOWN),
    },
    {
      heading: "Hosted servers that copy OpenAI's audio API",
      paragraphs: [
        `**Self-hosted** isn't limited to your own machine. It accepts any public HTTPS address with an API key, so a hosted service that serves OpenAI's audio endpoints can work there too: DeepInfra and Together AI host Kokoro for ${usd(RATES.deepinfraKokoro)} and ${usd(RATES.togetherKokoro)} per million characters, and Groq serves Whisper for ${usd(RATES.groqWhisperHour)} an hour. We haven't tested these with Rakazo, and two details matter. Rakazo sends speech and transcription to the same address, so the service needs to do both. And the voice list comes from the server; when a server doesn't publish one, Rakazo offers Kokoro's voice names, which only work if the service runs Kokoro.`,
        "Deepgram, Google, Azure and Amazon use their own API shapes, so **Self-hosted** can't reach them directly.",
      ],
      table: voicePriceTable("Self-hosted and hosted open models compared", COMPARED),
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
        "Choose the models. **Speech model** and **Transcription model** take whatever names your server uses.",
      ],
    },
    {
      heading: "When to choose self-hosted voice",
      paragraphs: [
        "Choose it when you don't want a hosted vendor to process your voice, when you want voice with no vendor account or usage bill, or when you already run local models. It pairs naturally with a [self-hosted Rakazo](/self-hosted-ai-agent/) and a local model, so the whole assistant can work offline.",
        "Hosted providers are less work and usually sound more polished. [ElevenLabs](/voice-providers/elevenlabs/) and [Fish Audio](/voice-providers/fish-audio/) offer cloning, [OpenAI](/voice-providers/openai/) reuses a key you may already have, and [Cartesia](/voice-providers/cartesia/) is tuned for low latency. If Rakazo runs directly on a Mac, [Server (Mac)](/voice-providers/macos/) speaks with nothing to install, but doesn't transcribe. See the [comparison](/voice-providers/) for all six.",
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
        "Watch the license. Several popular open models, including F5-TTS, XTTS-v2 and Fish Audio's open weights, aren't free for commercial use.",
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
      question: "What is Kokoro TTS?",
      answer:
        "Kokoro-82M is a small open source text to speech model, licensed Apache 2.0, with 54 voices in nine language variants. It runs faster than real time on an ordinary CPU and much faster on a GPU or Apple Silicon. It doesn't clone voices.",
    },
    {
      question: "Can I use Kokoro TTS with an AI agent?",
      answer:
        "Yes. Run Kokoro behind an OpenAI-compatible server such as Kokoro-FastAPI, Speaches or mlx-audio, then enter its URL under **Self-hosted** in Rakazo's voice settings. Rakazo lists the Kokoro voices and reads replies with the one you pick.",
    },
    {
      question: "What is the best open source text to speech model?",
      answer:
        "For most self-hosters, Kokoro: it's small, fast on a CPU and free for commercial use. For cloning under a permissive license, Chatterbox. Some higher-rated open-weight models, such as Fish Audio's, F5-TTS and XTTS-v2, are non-commercial.",
    },
    {
      question: "Can I use a local Whisper server for speech to text?",
      answer:
        "Yes, if it answers `/v1/audio/transcriptions` the way OpenAI does. Speaches and mlx-audio both do. Set **Transcription model** to the model name your server expects.",
    },
    {
      question: "Is self-hosting Whisper cheaper than the Whisper API?",
      answer:
        `For one person, on hardware you already have, yes: it costs only electricity, against ${usd(RATES.openaiWhisperHour)} an hour for OpenAI's Whisper or ${usd(RATES.openaiMiniTranscribeHour)} for \`gpt-4o-mini-transcribe\`. Renting a GPU just for transcription costs more than the API unless you transcribe many hours a day.`,
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
  sources: withPricingSources(
    [
    { label: "Kokoro-FastAPI", href: "https://github.com/remsky/Kokoro-FastAPI" },
    { label: "Kokoro-82M model", href: "https://huggingface.co/hexgrad/Kokoro-82M" },
    { label: "Speaches", href: "https://github.com/speaches-ai/speaches" },
    { label: "mlx-audio", href: "https://github.com/Blaizzy/mlx-audio" },
    { label: "faster-whisper", href: "https://github.com/SYSTRAN/faster-whisper" },
    { label: "Whisper large-v3-turbo", href: "https://huggingface.co/openai/whisper-large-v3-turbo" },
    { label: "Parakeet TDT 0.6B v3", href: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3" },
    {
      label: "Artificial Analysis, text to speech leaderboard",
      href: "https://artificialanalysis.ai/text-to-speech/leaderboard",
    },
    { label: "RunPod, pricing", href: "https://www.runpod.io/pricing" },
    PRICING_SOURCES.hetzner,
    PRICING_SOURCES.groq,
    VOICE_DOC,
    VOICE_MODELS_DOC,
    ],
    { prices: COMPARED, workload: WORKLOAD_SHOWN },
  ),
};
