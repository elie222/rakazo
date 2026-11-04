import { absolute, articleMarkdown, cell } from "../provider-article/markdown";
import type { ArticleHub, ArticleLink } from "../provider-article/types";
import { SITE_URL } from "../site";
import { cartesia } from "./cartesia";
import { elevenlabs } from "./elevenlabs";
import { fishAudio } from "./fish-audio";
import { macos } from "./macos";
import { openai } from "./openai";
import { selfHosted } from "./self-hosted";
import {
  VOICE_DOCS_PATH,
  VOICE_PROVIDERS_PATH,
  VOICE_PROVIDERS_UPDATED,
  voiceProviderPath,
} from "./shared";
import type { VoiceProvider } from "./types";

export * from "./shared";
export type { VoiceProvider } from "./types";

/** Display order everywhere integration providers are listed. */
export const VOICE_PROVIDERS: readonly VoiceProvider[] = [
  elevenlabs,
  openai,
  cartesia,
  fishAudio,
  selfHosted,
  macos,
];

export const VOICE_PROVIDERS_HUB = {
  title:
    "Best voice providers for AI agents in 2026: ElevenLabs, OpenAI, Cartesia, Fish Audio and self-hosted",
  description:
    "Which voice should your AI agent use? ElevenLabs, OpenAI, Cartesia, Fish Audio, a self-hosted speech server and macOS voices compared, from the team behind Rakazo.",
  h1: "Best voice providers for AI agents in 2026",
  intro: [
    "Typing isn't always the fastest way to work with an AI agent. Sometimes you want to say what you need on the way out the door, hear the answer while you cook, or have the agent call you when something can't wait. That takes two things: a voice that sounds right, and transcription that hears you correctly.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and you can also hold the mic to speak, have replies read aloud, or call a bot. A bot can call you too. The voice provider you connect does the speaking and, for most providers, the listening. This page compares every option Rakazo supports, from hosted voices to a server you run yourself.",
  ],
  scene: {
    bot: "Chief of Staff",
    color: "#3EC5A8",
    where: "On a call",
    ask: "call me at 5 to go over the day",
    reply: "calling now. two things need you, the rest is handled.",
    results: [
      { k: "Call", v: "6 min, transcript saved in the chat" },
      { k: "Decided", v: "harbor house booked, contract out" },
      { k: "Waiting", v: "your ok on the travel budget" },
    ],
  },
  choose: [
    {
      heading: "You want the most natural voices",
      text: "[ElevenLabs](/voice-providers/elevenlabs/) speaks and transcribes with one key, and any voice you clone in ElevenLabs shows up in Rakazo's voice picker. [Fish Audio](/voice-providers/fish-audio/) is the other pick when the voice itself matters, with expressive speech, your own cloned voice and a large public library.",
    },
    {
      heading: "You already have an OpenAI key",
      text: "[OpenAI](/voice-providers/openai/) is quick to set up, with built-in voices and solid transcription. OpenAI is shutting down the speech model Rakazo uses on January 6, 2027, so treat it as a convenient start.",
    },
    {
      heading: "You mostly call your bots",
      text: "[Cartesia](/voice-providers/cartesia/) voices start fast and sound natural on calls. It only speaks, so your browser, the desktop app or your phone does the listening.",
    },
    {
      heading: "You want audio to stay on your own hardware",
      text: "[Self-hosted voice](/voice-providers/self-hosted/) works with any OpenAI-compatible speech server, such as Kokoro for speech and a Whisper server for transcription. If you run Rakazo directly on a Mac, [macOS voices](/voice-providers/macos/) speak with no key at all.",
    },
  ],
  faq: [
    {
      question: "Can I talk to my AI agent by voice?",
      answer:
        "Yes. Connect a provider in **Settings → Voice**, then hold the mic to speak, have replies read aloud, or call a bot. On a [self-hosted Rakazo](/self-hosted-ai-agent/), the admin turns on calls and hold-to-talk with `PHONE_CALLS_ENABLED=true`.",
    },
    {
      question: "Which voice providers can transcribe?",
      answer:
        "ElevenLabs, OpenAI, Fish Audio, and self-hosted servers that support transcription. Cartesia and macOS voices only speak, so your browser, the desktop app or your phone listens instead.",
    },
    {
      question: "Can AI agents use voice without a hosted vendor?",
      answer:
        "Yes. Point Rakazo at a [self-hosted speech server](/voice-providers/self-hosted/), or use the [built-in macOS voices](/voice-providers/macos/) when the server runs on a Mac.",
    },
    {
      question: "Can each bot have its own voice?",
      answer:
        "Yes. In a bot's settings, turn on **Read replies aloud** and pick a **Voice** next to it to override your default for that bot.",
    },
    {
      question: "Can my bot call me?",
      answer:
        "Yes, in a one-to-one chat once you've connected a voice provider and calls are on. Ask \"call me at 5 to go over the day\", or a bot may call when you've missed the same reminder several times.",
    },
  ],
};

export const VOICE_PROVIDERS_ARTICLE_HUB: ArticleHub = {
  label: "Voice providers for AI agents",
  compareLabel: "Compare all voice providers",
  href: VOICE_PROVIDERS_PATH,
  moreHeading: "More voice providers for AI agents",
  guide: { label: "Voice and calls guide", href: VOICE_DOCS_PATH },
};

export function voiceProviderLink(provider: VoiceProvider): ArticleLink {
  return {
    name: provider.name,
    href: voiceProviderPath(provider.slug),
    meta: provider.bestFor,
    image: provider.image,
  };
}

export function otherVoiceProviders(provider: VoiceProvider): ArticleLink[] {
  return VOICE_PROVIDERS.filter((other) => other.slug !== provider.slug).map(
    voiceProviderLink,
  );
}

/** Markdown twin of an integration provider page, for agents and `.md` requests. */
export function voiceProviderMarkdown(provider: VoiceProvider): string {
  return articleMarkdown(provider, {
    hub: VOICE_PROVIDERS_ARTICLE_HUB,
    others: otherVoiceProviders(provider),
    updated: VOICE_PROVIDERS_UPDATED,
  });
}

/** Markdown twin of the integration providers hub. */
export function voiceProvidersHubMarkdown(): string {
  const hub = VOICE_PROVIDERS_HUB;
  return [
    `# ${hub.h1}`,
    "",
    ...hub.intro.flatMap((paragraph) => [absolute(paragraph), ""]),
    `Updated ${VOICE_PROVIDERS_UPDATED}.`,
    "",
    "## Compared",
    "",
    "| Provider | Does | Runs | Best for |",
    "| --- | --- | --- | --- |",
    ...VOICE_PROVIDERS.map(
      (provider) =>
        `| [${cell(provider.name)}](${SITE_URL}${voiceProviderPath(provider.slug)}) | ${cell(provider.does)} | ${cell(provider.runs)} | ${cell(provider.bestFor)} |`,
    ),
    "",
    "## How to choose",
    "",
    ...hub.choose.flatMap((item) => [`### ${item.heading}`, "", absolute(item.text), ""]),
    `[Voice and calls guide](${SITE_URL}${VOICE_DOCS_PATH})`,
    "",
    "## FAQ",
    "",
    ...hub.faq.flatMap((item) => [`### ${item.question}`, "", absolute(item.answer), ""]),
  ].join("\n");
}
