import type { VoiceProvider } from "./types";
import {
  PRICING_SOURCES,
  VOICE_DOC,
  VOICE_MODELS_DOC,
  WORKLOAD,
  homepage,
  voicePriceTable,
  voiceWorkloadTable,
} from "./shared";

export const fishAudio: VoiceProvider = {
  slug: "fish-audio",
  name: "Fish Audio",
  does: "Speaks and transcribes",
  runs: "Hosted",
  bestFor: "Expressive voices and your own cloned voice",
  title: "Fish Audio pricing, API and alternatives for AI agents (2026)",
  description:
    "Fish Audio pricing explained: app plans, API rates per million bytes, the free S2.1 Pro offer, transcription per hour, open weights and licensing, and how it compares with ElevenLabs. How to use the Fish Audio API with AI agents in Rakazo.",
  h1: "Fish Audio for AI agents: pricing, API and setup",
  intro: [
    "[Fish Audio](https://fish.audio) is a hosted voice platform for text to speech, voice cloning and speech to text. It has a large library of voices that its users have published, and you can clone a voice of your own from a short recording. Everything it does in the app is also available through its API.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and you can also talk to it by voice: hold the mic to speak, have replies read aloud, or call a bot in real time. With a Fish Audio key, your bots speak in a Fish Audio voice and Fish Audio turns what you say into text.",
    "This page covers Fish Audio's plans and API prices as of November 2026, what a bot that talks every day costs, its open models and licensing, and how it compares with ElevenLabs and others.",
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
        "Fish Audio offers three things that matter to an AI agent: speech, cloning and transcription. Its speech models turn text into audio in a chosen voice, and its [documentation](https://docs.fish.audio) recommends `s2.1-pro` for production, which supports 83 languages. Its transcription model, `transcribe-1-pro`, handles several languages and multiple speakers. A newer, larger model, `drama-3`, is aimed at multi-character scenes and long content.",
        "Every voice is a model in your Fish Audio account or in its public library. Clone one from a clip in the Fish Audio app and it becomes a voice your API key can use.",
      ],
      image: true,
    },
    {
      heading: "Fish Audio pricing: app plans",
      paragraphs: [
        "The Fish Audio app is sold in monthly plans with credits; one minute of generated speech uses about 600 to 625 credits. Unused credits don't roll over. These plans cover the app; API use is billed separately, below.",
      ],
      table: {
        caption: "Fish Audio app plans, as of November 2026",
        columns: ["Plan", "A month", "Credits a month", "About minutes of speech", "Cloned voices"],
        rows: [
          { topic: "Free", cells: ["$0", "8,000", "7", "Public voices only"] },
          { topic: "Plus", cells: ["$15, or $11 billed yearly", "250,000", "200", "10 private, 1 professional"] },
          { topic: "Pro", cells: ["$100, or $75 billed yearly", "2M", "1,620", "Unlimited, 5 professional"] },
        ],
        note: "From [Fish Audio's plans page](https://fish.audio/plan), checked November 2026. The plan card and the FAQ disagree on whether the Free plan allows commercial use; the FAQ says personal, non-commercial only.",
      },
    },
    {
      heading: "Fish Audio API pricing",
      paragraphs: [
        "The API is pay as you go with no subscription. Speech is priced per million bytes of UTF-8 text, so English costs about the same per character, while Chinese, Japanese and Korean text, at three bytes a character, costs about three times as much per character. Fish Audio says a million bytes is about 12 hours of English speech.",
        "Until November 30, 2026, Fish Audio offers its flagship as `s2.1-pro-free` at no cost, with no card required, under a fair use policy, without an uptime guarantee, and with requests that may be used to improve its models. The end date has already been extended several times. Because Rakazo lets you enter a Fish Audio **Speech model**, you can try that name there.",
      ],
      table: {
        caption: "Fish Audio API prices, as of November 2026",
        columns: ["Model", "Price", "About per hour"],
        rows: [
          { topic: "`s2.1-pro` (Rakazo's default)", cells: ["$15 per 1M bytes", "$0.81"] },
          { topic: "`s2.1-pro-free`", cells: ["$0, until November 30, 2026", "$0"] },
          { topic: "`s2-pro`", cells: ["$15 per 1M bytes", "$0.81"] },
          { topic: "`s1`", cells: ["$15 per 1M bytes, retiring December 31, 2026", "$0.81"] },
          { topic: "`drama-3`", cells: ["$50 per 1M bytes ($10 until November 12, 2026)", "$2.70"] },
          { topic: "`transcribe-1-pro` (Rakazo's default)", cells: ["$0.36 per audio hour", "$0.36"] },
        ],
        note: "From [Fish Audio's API pricing page](https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits), checked November 2026. Hourly speech figures assume about 54,000 bytes of English text an hour. Transcription bills the full recording, rounded up to the second; failed requests aren't billed.",
      },
    },
    {
      heading: "What a talking Rakazo bot costs on Fish Audio",
      paragraphs: [
        "Rakazo calls Fish Audio with your key, so Fish Audio bills you and Rakazo adds nothing.",
        `${WORKLOAD} On Fish Audio that is about $12 of S2.1 Pro speech and $5.40 of transcription: roughly $18 a month, half what ElevenLabs costs for the same use. While the free S2.1 Pro offer lasts, the speech part can be $0.`,
      ],
      table: voiceWorkloadTable("One bot, 30 minutes of speech and 30 of transcription a day", [
        "fish",
        "elevenlabs",
        "openai",
        "cartesia",
        "selfHosted",
      ]),
    },
    {
      heading: "Fish Audio vs ElevenLabs and other voice APIs",
      paragraphs: [
        "Fish Audio's pitch is ElevenLabs-class expressive voices and cloning at a fraction of the price. Per character it costs about a third of ElevenLabs Flash v2.5, and independent blind tests have ranked its models near the top. ElevenLabs still has the more established platform, broader compliance paperwork and enterprise data residency. Fish Audio's transcription costs more per hour than ElevenLabs Scribe.",
      ],
      table: voicePriceTable("Fish Audio compared with other voice APIs", [
        "fish",
        "elevenlabs",
        "openai",
        "cartesia",
        "deepgram",
        "google",
        "selfHosted",
      ]),
    },
    {
      heading: "Is Fish Audio open source?",
      paragraphs: [
        "Partly. The [fish-speech](https://github.com/fishaudio/fish-speech) code and some model weights are public: S2-Pro (4B parameters) and Drama 3 can be downloaded from Hugging Face. They are released under Fish Audio's own licenses, which allow research and non-commercial use for free and require a separate license for commercial use. The S2.1 Pro weights that the API serves are not public.",
        "So you can run Fish models yourself for a personal assistant, but a business needs a license from Fish Audio. Fish Audio's own self-hosted deployment is an enterprise contract, starting at $10,000 plus a $10,000 monthly minimum. For voice models you can run commercially for free, such as Kokoro, see [self-hosted voice](/voice-providers/self-hosted/).",
      ],
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
        "Choose the speech model. Enter another Fish Audio model name under **Speech model**, such as `s2-pro`, instead of the default `s2.1-pro`.",
      ],
    },
    {
      heading: "When to choose Fish Audio",
      paragraphs: [
        "Choose Fish Audio when the voice itself matters and so does the price: a cloned voice, an unusual character, or a language where you want more choice than a fixed set of voices gives you. It speaks and transcribes, so one account does both.",
        "[ElevenLabs](/voice-providers/elevenlabs/) is the other choice for cloning and polished voices, with more enterprise controls. [OpenAI](/voice-providers/openai/) is simplest if you already have a key, and [Cartesia](/voice-providers/cartesia/) is built for low-latency speech but does not transcribe. To keep voice off hosted services entirely, run a [self-hosted speech server](/voice-providers/self-hosted/), or use the [voices built into a Mac](/voice-providers/macos/) when Rakazo runs on one. The [voice provider comparison](/voice-providers/) puts all six side by side.",
      ],
    },
    {
      heading: "Limits and gotchas",
      bullets: [
        "Fish Audio is a hosted service. The text your bots speak and the audio you record are sent to it, and use comes out of your Fish Audio account. Its free app plan is for personal use only.",
        "Data is hosted in the US, with processing in the US and Tokyo. Zero data retention is for enterprise contracts, and its SOC 2 audit was still underway as of November 2026.",
        "API requests at once depend on how much you've prepaid in total: 5 under $100, 15 from $100, 50 from $1,000. Over the limit, requests fail until one finishes.",
        "The public voice library includes voices uploaded by other users, and voice actors have reported clones made without consent. Fish Audio handles DMCA takedowns. Only use voices you have the right to use, especially for anything public.",
        "Rakazo asks Fish Audio for each reply as a finished clip. It doesn't use Fish Audio's realtime streaming API.",
        "The voice picker shows your own voices and the top public voices, not the whole library.",
        "When your Fish Audio balance runs out or the key is rejected, speaking and transcribing stop until you fix the account.",
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
      question: "How much does Fish Audio cost?",
      answer:
        "As of November 2026, the app has a Free plan, Plus at $15 a month ($11 billed yearly) and Pro at $100 ($75 yearly). The API is pay as you go: $15 per million bytes of text for S2.1 Pro, about $0.81 per hour of English speech, and $0.36 per hour of transcription.",
    },
    {
      question: "Is Fish Audio free?",
      answer:
        "The app has a free plan with about 7 minutes of speech a month for personal use. Through the API, `s2.1-pro-free` costs nothing until November 30, 2026, under a fair use policy.",
    },
    {
      question: "Is Fish Audio safe to use?",
      answer:
        "It's an established service with millions of users, and paid plans include commercial rights. The concerns people raise are about its public voice library, where some voices were uploaded without the speaker's consent, and that your text and audio are processed on its servers in the US. Use your own or licensed voices.",
    },
    {
      question: "Can I use a cloned Fish Audio voice for my AI agent?",
      answer:
        "Yes. Clone the voice in your Fish Audio account, then pick it from the **Voice** list in Rakazo's voice settings. Your own voices are listed before public ones.",
    },
    {
      question: "Does the Fish Audio API do speech to text?",
      answer:
        "Yes. Rakazo uses it to transcribe what you say when you hold the mic or talk on a call, with `transcribe-1-pro` by default, at $0.36 per hour of audio.",
    },
    {
      question: "Which Fish Audio model does Rakazo use?",
      answer:
        "`s2.1-pro` for speech and `transcribe-1-pro` for transcription. You can enter another speech model in **Settings → Voice**, and a self-hosted server can change both defaults.",
    },
    {
      question: "Fish Audio vs ElevenLabs?",
      answer:
        "Both offer expressive voices, cloning and transcription, and both work fully in Rakazo. Fish Audio costs about a third as much per character. [ElevenLabs](/voice-providers/elevenlabs/) has cheaper transcription, a more established platform, and enterprise options such as EU data residency.",
    },
  ],
  sources: [
    { label: "Fish Audio", href: "https://fish.audio" },
    { label: "Fish Audio documentation", href: "https://docs.fish.audio" },
    PRICING_SOURCES.fish,
    PRICING_SOURCES.fishPlans,
    { label: "Fish Audio, free S2.1 Pro API", href: "https://fish.audio/blog/s2-1-pro-free-api/" },
    { label: "Fish Audio, enterprise", href: "https://fish.audio/enterprise/" },
    { label: "fish-speech on GitHub", href: "https://github.com/fishaudio/fish-speech" },
    PRICING_SOURCES.elevenlabsApi,
    PRICING_SOURCES.openai,
    PRICING_SOURCES.cartesia,
    PRICING_SOURCES.deepgram,
    PRICING_SOURCES.google,
    VOICE_DOC,
    VOICE_MODELS_DOC,
  ],
};
