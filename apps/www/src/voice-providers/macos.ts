import type { VoiceProvider } from "./types";
import { GITHUB_URL } from "../site";
import { VOICE_DOC, VOICE_MODELS_DOC, voicePriceTable, withPricingSources } from "./shared";

const COMPARED = ["macos", "selfHosted", "openai", "fish", "elevenlabs", "cartesia"] as const;

export const macos: VoiceProvider = {
  slug: "macos",
  name: "macOS voices",
  does: "Speaks only",
  runs: "Your Mac",
  bestFor: "Running Rakazo on a Mac with no voice key",
  title: "macOS text to speech for AI agents: the built-in Mac voices, free and with no API key",
  description:
    "How macOS text to speech works, from Read & Speak to the say command and Premium voices, and how Rakazo uses the Mac's built-in voices so AI agents can read replies and call you for free. Compared with paid voice APIs, with limits and setup.",
  h1: "macOS text to speech for AI agents: use your Mac's built-in voices",
  intro: [
    "Every Mac ships with dozens of text-to-speech voices, and Apple offers Enhanced and Premium versions that sound more natural. The `say` command turns text into speech with any of them, entirely on the machine, with no account and no API key.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and you can also talk to it by voice: hold the mic to speak, have replies read aloud, or call a bot in real time. When the Rakazo server runs directly on a Mac, it offers **Server (Mac)** as a voice provider, so bots speak with that Mac's voices and no voice vendor.",
  ],
  scene: {
    bot: "Chief of Staff",
    color: "#3EC5A8",
    where: "Voice from the server's Mac",
    ask: "call me at 5 to go over the day",
    reply: "will do. i'll ring you at 5.",
    results: [
      { k: "Voice", v: "Zoe (Premium), built into macOS" },
      { k: "Key", v: "None needed" },
      { k: "Call", v: "4 min, transcript in chat" },
    ],
  },
  sections: [
    {
      heading: "What are macOS voices?",
      paragraphs: [
        "They are the system voices macOS uses for its own spoken content, such as reading selected text aloud. The `/usr/bin/say` command speaks with any installed voice and can save the result to an audio file instead of playing it, which is what Rakazo does.",
        "Voices come in three tiers: Compact, which is small and robotic; Enhanced; and Premium, the most natural, available for a handful of voices such as Ava and Zoe in US English and Jamie and Serena in British English. Siri's voices aren't available to `say`. Personal Voice, the voice you can record of yourself, is only available to apps you grant permission to.",
      ],
      image: true,
    },
    {
      heading: "How to use text to speech on a Mac",
      paragraphs: [
        "In macOS 26 and later, Apple renamed the **Spoken Content** settings to **Read & Speak**. That's where you pick the system voice and download better ones; older guides still use the old name.",
      ],
      steps: [
        "Open **System Settings → Accessibility → Read & Speak**. On macOS 15 and earlier, it's **Accessibility → Spoken Content**.",
        "Choose a voice from the **System voice** menu. To get Enhanced or Premium voices, click the Info button next to it, pick a language, and click a voice to download it.",
        "Turn on **Speak selection** to have the Mac read any selected text with a keyboard shortcut, Option-Esc by default.",
        "In Terminal, `say -v '?'` lists installed voices, `say -v 'Zoe (Premium)' \"hello\"` speaks, and `say -o hello.aiff \"hello\"` saves the audio to a file.",
      ],
    },
    {
      heading: "What it costs",
      paragraphs: [
        "Nothing. The voices come with macOS, run on the Mac's own processor, and have no usage limit. That's the whole case for them: a bot that reads replies all day costs the same as one that never speaks. The trade-off is quality, since even Premium voices sound less natural than the best hosted ones, and there's no transcription.",
      ],
      table: voicePriceTable("macOS voices compared with paid voice APIs", COMPARED),
    },
    {
      heading: "What you can do with macOS voices in Rakazo",
      paragraphs: [
        "The server renders each reply into a short audio clip with `say` and sends it to whoever is listening, so it plays on your phone or laptop like any other voice, not out of the server's speakers. The [voice and calls guide](/docs/voice-and-calls/) covers each feature.",
      ],
      bullets: [
        "Hear replies. Choose **Speak this reply** on a message, or turn on **Read replies aloud** in a bot's settings.",
        "Call a bot with **Call** at the top of the chat, or have a bot call you when you ask it to.",
        "Talk instead of typing, using on-device speech recognition. macOS voices don't transcribe, so your words are recognized by your browser, such as Chrome, or by the Rakazo desktop app on a Mac.",
        "Choose any installed voice, and a different one for each bot. Premium and Enhanced voices are listed first.",
      ],
    },
    {
      heading: "When to choose macOS voices",
      paragraphs: [
        "Choose them when you run Rakazo on your own Mac and want bots to speak right away, with nothing to sign up for, nothing to install and nothing to pay. Speech is made on the machine running Rakazo, with no vendor involved, then sent to whichever device is listening.",
        "For voices that also transcribe, a [self-hosted speech server](/voice-providers/self-hosted/) keeps everything on your own hardware and works on Linux too; on a Mac, mlx-audio runs Kokoro and Whisper quickly. Hosted providers sound more natural and need a key: [ElevenLabs](/voice-providers/elevenlabs/) and [Fish Audio](/voice-providers/fish-audio/) clone voices, [OpenAI](/voice-providers/openai/) is the simplest, and [Cartesia](/voice-providers/cartesia/) is built for low latency. The [voice provider comparison](/voice-providers/) shows all six.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        "Rakazo only offers **Server (Mac)** when its server process runs directly on macOS. A server in Docker, including Docker Desktop on a Mac and the desktop app's **This computer** install, runs Linux inside the container, so the option doesn't appear. Linux hosts don't list it either.",
        "It doesn't transcribe. Hold-to-talk and calls depend on speech recognition in your browser or the desktop app, and voice notes from messaging apps reach bots without a transcript.",
        "macOS voices sound less natural than the best hosted voices, and there's no voice cloning.",
        "The voices are whatever is installed on the server's Mac. A newly downloaded voice can take a few minutes to show up.",
        "Rakazo lists the voices `say -v '?'` reports. We haven't tested Personal Voice, which needs the server process to be granted permission.",
        "On the mobile app, calls can use your phone's own voices if you pick a **Device voice** in the bot's settings. Otherwise replies use this provider.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "This is for someone running Rakazo from source on their own Mac. The [self-hosting guide](/docs/self-host/) has the full instructions.",
      ],
      steps: [
        "On the Mac, clone Rakazo, copy `.env.example` to `.env`, then run `pnpm install`, `pnpm sandbox:build` and `pnpm dev`. This runs the Rakazo API directly on macOS.",
        "To use hold-to-talk and calls, set `PHONE_CALLS_ENABLED=true` in `.env` and restart.",
        "Optionally download Enhanced or Premium voices under **System Settings → Accessibility → Read & Speak**, with the Info button next to **System voice**.",
        "In Rakazo, open **Settings → Voice** and set **Provider** to **Server (Mac)**. There's no key to enter.",
        "Pick a **Voice** and choose **Hear a sample**.",
      ],
    },
  ],
  image: {
    webp: "/graphics/voice-providers/macos.webp",
    avif: "/graphics/voice-providers/macos.avif",
    width: 1280,
    height: 720,
    alt: "Rakazo showing an incoming call from the bot Chief, with Decline and Answer buttons beside the chat.",
    caption: "Chief calling from Rakazo. With macOS voices, its side of the call is spoken by the server's Mac.",
  },
  faq: [
    {
      question: "Does macOS have text to speech?",
      answer:
        "Yes. Turn on **Speak selection** under **System Settings → Accessibility → Read & Speak** (Spoken Content before macOS 26) to have any selected text read aloud, or use the `say` command in Terminal. It's free and works offline.",
    },
    {
      question: "Can an AI assistant use the macOS say command?",
      answer:
        "Yes. When Rakazo's server runs on a Mac, it uses `say` to turn each reply into an audio clip in the voice you pick, with no API key.",
    },
    {
      question: "Why don't I see Server (Mac) in Rakazo?",
      answer:
        "The option only appears when the Rakazo server runs directly on macOS. In Docker, even on a Mac, the server runs on Linux and can't reach `say`. Use a self-hosted speech server there instead.",
    },
    {
      question: "Can macOS voices transcribe what I say?",
      answer:
        "No, they only speak. Rakazo uses on-device speech recognition from your browser or the desktop app for your side, or you can switch to a provider that transcribes.",
    },
    {
      question: "How do I get better macOS voices?",
      answer:
        "Download Enhanced or Premium voices on the server's Mac: in **System Settings → Accessibility → Read & Speak**, click the Info button next to **System voice**, pick a language and click a voice. Rakazo lists them first.",
    },
    {
      question: "Are macOS voices as good as ElevenLabs?",
      answer:
        "No. Premium voices are clear and pleasant, but hosted voices from [ElevenLabs](/voice-providers/elevenlabs/) or [Fish Audio](/voice-providers/fish-audio/) sound noticeably more human. macOS voices are free and private, which is why they're worth trying first.",
    },
  ],
  sources: withPricingSources(
    [
    {
      label: "Apple, change the voice your Mac uses to speak text",
      href: "https://support.apple.com/guide/mac-help/mchlp2290/mac",
    },
    { label: "ss64, the say command", href: "https://ss64.com/mac/say.html" },
    VOICE_DOC,
    VOICE_MODELS_DOC,
    { label: "Rakazo, self-hosting", href: `${GITHUB_URL}/blob/main/docs/self-host.md` },
    ],
    { prices: COMPARED },
  ),
};
