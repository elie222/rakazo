import type { VoiceProvider } from "./types";
import {
  CHARS_PER_HOUR,
  CHARS_PER_MINUTE,
  PRICING_SOURCES,
  RATES,
  VOICE_DOC,
  WORKLOAD,
  WORKLOAD_COST,
  WORKLOAD_DAILY_MINUTES,
  aboutTotal,
  count,
  credits,
  homepage,
  cartesiaPerMillion,
  perHourOfSpeech,
  priceVersus,
  shareOf,
  usd,
  withPricingSources,
  voicePriceTable,
  voiceWorkloadTable,
} from "./shared";

/** The worked example's ElevenLabs cost, scaled to another number of minutes a day. */
function scaled(dailyMinutes: number, part: "speech" | "both"): number {
  const { speech, transcription } = WORKLOAD_COST.elevenlabs;
  const cost = part === "speech" ? speech : speech + transcription;
  return (cost * dailyMinutes) / WORKLOAD_DAILY_MINUTES;
}

const PLANS = RATES.elevenlabsPlans;
const FLASH = RATES.elevenlabsFlash;

const WORKLOAD_SHOWN = ["elevenlabs", "openai", "cartesia", "fish", "selfHosted", "deepgram"] as const;
const COMPARED = [
  "elevenlabs",
  "elevenlabsV4",
  "openai",
  "cartesia",
  "fish",
  "deepgram",
  "google",
  "azure",
  "selfHosted",
] as const;

const FLASH_HOUR = perHourOfSpeech(RATES.elevenlabsFlash);
const V4_HOUR = perHourOfSpeech(RATES.elevenlabsV4);

export const elevenlabs: VoiceProvider = {
  slug: "elevenlabs",
  name: "ElevenLabs",
  does: "Speaks and transcribes",
  runs: "Hosted",
  bestFor: "The most natural voices, including ones you clone",
  title: "ElevenLabs pricing, API costs and alternatives for AI agents (2026)",
  description:
    "ElevenLabs pricing explained: plans, API rates per character and per hour, Scribe transcription, and what a talking AI agent costs a month. Compared with OpenAI, Cartesia, Fish Audio, Deepgram and self-hosted voice, with setup in Rakazo.",
  h1: "ElevenLabs for AI agents: pricing, alternatives and setup",
  intro: [
    "[ElevenLabs](https://elevenlabs.io) is a voice AI company best known for natural, expressive text to speech and voice cloning. Its API also transcribes speech, so one key covers both directions of a conversation.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and you can also talk to it by voice: hold the mic to speak, have replies read aloud, or call a bot in real time. Connect ElevenLabs and it does the speaking and the transcription. Rakazo runs the bot, decides what it says, and keeps the transcript in the chat.",
    "This page covers what ElevenLabs costs as of November 2026, how its plans and API billing differ, what a bot that talks every day actually costs, and how it compares with the alternatives.",
  ],
  scene: {
    bot: "Chief of Staff",
    color: "#3EC5A8",
    where: "Voice from ElevenLabs",
    ask: "call me at 5 to go over the day",
    reply: "will do. talk at 5.",
    results: [
      { k: "Call", v: "answered at 5:00pm" },
      { k: "Decided", v: "board prep moves to Thursday" },
      { k: "Decided", v: "decline the vendor demo" },
      { k: "Transcript", v: "saved in this chat" },
    ],
  },
  sections: [
    {
      heading: "What is ElevenLabs?",
      paragraphs: [
        "[ElevenLabs](https://elevenlabs.io) makes speech models and the products built on them: an AI voice generator, dubbing, an audiobook reader, and a platform for voice agents. Developers reach the same models through its API.",
        "Its text to speech is known for sounding human, with emotion and natural pacing, in many languages. As of November 2026 the lineup is Eleven v4, its most expressive model (released September 2026), v4 Turbo for low latency, and Flash v2.5, a fast conversational model with about 100 ms of model latency in 32 languages. Scribe v2 and Scribe v2 Realtime turn speech back into text. You can clone a voice from a recording, design a new one, or pick from a large shared voice library.",
      ],
      image: true,
    },
    {
      heading: "ElevenLabs pricing in 2026",
      paragraphs: [
        "ElevenLabs sells monthly plans for its apps, and bills its API in dollars per character. The plans differ in included credits, commercial rights, voice cloning and how many requests can run at once. Annual billing costs ten months' price for twelve.",
      ],
      table: {
        caption: "ElevenLabs plans, as of November 2026",
        columns: [
          "Plan",
          "A month",
          "Credits a month",
          "Commercial use",
          "Voice cloning",
          "Requests at once",
        ],
        rows: [
          {
            topic: "Free",
            cells: [usd(PLANS.free.price), credits(PLANS.free.credits), "No, attribution required", "None", "2"],
          },
          {
            topic: "Starter",
            cells: [usd(PLANS.starter.price), credits(PLANS.starter.credits), "Yes", "Instant", "3"],
          },
          {
            topic: "Creator",
            cells: [usd(PLANS.creator.price), credits(PLANS.creator.credits), "Yes", "Instant, 1 Professional", "5"],
          },
          {
            topic: "Pro",
            cells: [usd(PLANS.pro.price), credits(PLANS.pro.credits), "Yes", "Instant, 1 Professional", "10"],
          },
          {
            topic: "Scale",
            cells: [`${usd(PLANS.scale.price)}, 3 seats`, credits(PLANS.scale.credits), "Yes", "3 Professional", "15"],
          },
          {
            topic: "Business",
            cells: [`${usd(PLANS.business.price)}, 10 seats`, credits(PLANS.business.credits), "Yes", "10 Professional", "25"],
          },
          { topic: "Enterprise", cells: ["Custom", "Custom", "Yes", "Custom", "Custom"] },
        ],
        note: `From [ElevenLabs' pricing page](https://elevenlabs.io/pricing), checked November 2026. In the apps, text to speech uses about 1 credit per character, so about ${count(CHARS_PER_MINUTE)} credits per minute of speech at the pace these tables assume.`,
      },
    },
    {
      heading: "ElevenLabs API pricing per character and per hour",
      paragraphs: [
        "The API is what Rakazo uses, and it is billed differently from the apps. Each model has a dollar price per 1,000 characters that is the same on every plan; a subscription includes some usage, and Pay As You Go lets you top up a dollar balance (from $5, valid for 12 months) with or without a plan. Without auto top-up, requests stop at $0 instead of running up a bill. Older guides quoting $0.10 per 1,000 characters predate a 2026 price cut.",
      ],
      table: {
        caption: "ElevenLabs API rates, as of November 2026",
        columns: ["Model", "Per 1,000 characters", "Per 1M characters", "About per hour"],
        rows: [
          {
            topic: "Flash v2.5 (Rakazo uses this)",
            cells: [usd(RATES.elevenlabsFlash / 1000), usd(RATES.elevenlabsFlash), FLASH_HOUR],
          },
          {
            topic: "v4 Turbo, v3 Conversational",
            cells: [usd(RATES.elevenlabsFlash / 1000), usd(RATES.elevenlabsFlash), FLASH_HOUR],
          },
          {
            topic: "Eleven v4, v3, Multilingual v2",
            cells: [usd(RATES.elevenlabsV4 / 1000), usd(RATES.elevenlabsV4), V4_HOUR],
          },
          { topic: "Scribe v2 transcription (Rakazo uses this)", cells: ["—", "—", `${usd(RATES.elevenlabsScribeHour)} of audio`] },
          {
            topic: "Scribe v2 Realtime",
            cells: ["—", "—", `${usd(RATES.elevenlabsScribeRealtimeHour)} of audio`],
          },
          {
            topic: "ElevenLabs Agents platform",
            cells: [
              "—",
              "—",
              `${usd(RATES.elevenlabsAgentsMinute * 60)} (${usd(RATES.elevenlabsAgentsMinute)} a minute) plus the LLM`,
            ],
          },
        ],
        note: `From [ElevenLabs' API pricing page](https://elevenlabs.io/pricing/api), checked November 2026. An hour of speech is taken as about ${count(CHARS_PER_HOUR)} characters.`,
      },
    },
    {
      heading: "What a talking Rakazo bot costs on ElevenLabs",
      paragraphs: [
        "Rakazo calls ElevenLabs with your key, so ElevenLabs bills you at its API rates and Rakazo adds nothing on top. The cost depends on how much your bots say and how much of your speech is transcribed on the server.",
        `${WORKLOAD} On ElevenLabs that comes to ${usd(WORKLOAD_COST.elevenlabs.speech)} of Flash v2.5 speech and ${usd(WORKLOAD_COST.elevenlabs.transcription)} of Scribe v2 transcription: ${aboutTotal("elevenlabs").toLowerCase()} a month. A light user who hears and speaks 10 minutes a day pays around $${Math.round(scaled(10, "both"))}; a bot that talks for two hours a day costs about $${Math.round(scaled(120, "speech") / 10) * 10} in speech alone.`,
        "Two things lower the bill. In Chrome on a desktop, the mic uses the browser's own speech recognition, so that transcription costs nothing. And a self-hosted Rakazo can set `VOICE_SUMMARY_MIN_CHARS` so long replies are read as a short summary instead of in full, which cuts characters at the cost of one extra model call.",
      ],
      table: voiceWorkloadTable(
        "One bot, 30 minutes of speech and 30 of transcription a day",
        WORKLOAD_SHOWN,
      ),
    },
    {
      heading: "ElevenLabs vs OpenAI, Cartesia, Fish Audio and Deepgram",
      paragraphs: [
        `ElevenLabs is not the cheapest voice. Per character, Flash v2.5 is ${priceVersus(FLASH, cartesiaPerMillion("startup"))} Cartesia on its Startup plan and ${priceVersus(FLASH, RATES.deepgram)} Deepgram's Aura-2, while Fish Audio costs ${shareOf(RATES.fish, FLASH)} its price and OpenAI's \`tts-1\` ${shareOf(RATES.openaiTts1, FLASH)} it. What you pay for is voice quality, the size of the voice library and cloning that people consistently rate among the best.`,
      ],
      table: voicePriceTable("ElevenLabs compared with other voice APIs", COMPARED),
    },
    {
      heading: "ElevenLabs alternatives",
      paragraphs: [
        `The best alternative depends on why you're leaving. If it's price, [Fish Audio](/voice-providers/fish-audio/) costs ${shareOf(RATES.fish, FLASH)} the per-character price, with cloning and a big voice library, and a [self-hosted](/voice-providers/self-hosted/) Kokoro server costs only hardware. If it's latency on calls, [Cartesia](/voice-providers/cartesia/) is built for it, though in Rakazo it only speaks. If you already pay OpenAI, [OpenAI](/voice-providers/openai/) is the quickest start, but its speech model shuts down on January 6, 2027.`,
        `Outside Rakazo, Deepgram is strong at transcription (Nova-3 from ${usd(RATES.deepgramBatchHour)} an hour) with Aura-2 voices that are ${priceVersus(RATES.deepgram, FLASH)} Flash v2.5 but plainer; Google, Azure and Amazon Polly are cheap at scale and come with cloud compliance paperwork; Hume and Inworld focus on expressive or low-cost voices for agents. PlayHT, once a common alternative, shut down at the end of 2025. Rakazo has no built-in connection for any of these.`,
      ],
    },
    {
      heading: "What you can do with ElevenLabs in Rakazo",
      paragraphs: [
        "ElevenLabs both speaks and transcribes, so it covers every voice feature in Rakazo. The [voice and calls guide](/docs/voice-and-calls/) shows where each control lives.",
      ],
      bullets: [
        "Talk instead of typing. Hold the mic in the composer, speak, and let go to send. When Rakazo transcribes on the server, as it does in a phone browser or the desktop app, it uses ElevenLabs' `scribe_v2`.",
        "Hear replies. Choose **Speak this reply** on any message, or turn on **Read replies aloud** in a bot's settings to hear everything it says.",
        "Call a bot. Choose **Call** at the top of a chat to talk in real time. You can cut in while the bot is speaking, and the transcript stays in the chat.",
        "Get called. Ask \"call me at 5 to go over the day\" and the bot rings you then. A bot may also call if you've missed the same reminder several times.",
        "Give each bot its own voice. The **Voice** next to **Read replies aloud** overrides your default for that bot, so your inbox bot and your sales bot don't sound alike.",
        "Use your own voices. The voice picker lists the voices in your ElevenLabs account, including ones you cloned or saved from its library.",
        "Send voice notes from chat apps. A voice note sent to a bot through Telegram, for example, is transcribed with ElevenLabs before the bot reads it. See [messaging apps](/docs/messaging-apps/).",
      ],
    },
    {
      heading: "When to choose ElevenLabs",
      paragraphs: [
        "Choose ElevenLabs when the voice itself matters: you'll listen to a bot every day, you want it to sound like a person, or you want it to sound like a specific person you have permission to clone. It is also the simplest choice for full voice support, since one key speaks and transcribes, and its Scribe transcription is among the cheapest hosted options.",
        "Skip it if cost per hour is what you're optimizing, if you need audio to stay on your own hardware, or if you need data residency or zero retention without an Enterprise contract. The [comparison](/voice-providers/) puts every option side by side.",
      ],
    },
    {
      heading: "Limits and gotchas",
      bullets: [
        "Rakazo speaks with Eleven Flash v2.5 (`eleven_flash_v2_5`), ElevenLabs' fast model for conversation, unless you enter another **Speech model**.",
        "Rakazo doesn't clone voices itself. Create the clone in ElevenLabs first, then pick it in Rakazo.",
        "Each sentence is generated as a finished clip and played in order, rather than streamed word by word, so there is a short pause before the bot starts talking.",
        "Speech and transcription go through ElevenLabs' servers and use your ElevenLabs account's balance. If it runs out, Rakazo tells you so instead of failing quietly.",
        "The Free plan is for non-commercial use with attribution. A bot that talks to customers needs a paid plan.",
        "Unused plan credits roll over for up to two months, but cancelling or downgrading forfeits them at the end of the cycle. Recent reviews complain about exactly this, so downgrade after you've used them.",
        "Zero retention mode and data residency in the EU, India or Singapore are Enterprise-only.",
        "Calls and hold-to-talk are a server setting. On a self-hosted server they stay off until the admin turns them on.",
        "In a desktop browser such as Chrome, Rakazo may use the browser's own speech recognition for the mic instead of ElevenLabs.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "Anyone can do this in their own settings, on Rakazo Cloud or a self-hosted server. The key belongs to your account, not the whole server.",
      ],
      steps: [
        "Create an API key in your [ElevenLabs](https://elevenlabs.io) account. Give it permission for text to speech, speech to text and reading voices.",
        "In Rakazo, open **Settings → Voice**, choose **ElevenLabs** as the **Provider**, paste the **API key** and choose **Connect**.",
        "Pick a **Voice** and use **Hear a sample** to check it.",
        "Optionally enter a **Speech model**, such as `eleven_v4`, to use a more expressive model than the default `eleven_flash_v2_5`.",
        "Optionally, open a bot's settings, expand **Advanced**, turn on **Read replies aloud** and give it its own **Voice**.",
        "If you run your own server and want calls and hold-to-talk, set `PHONE_CALLS_ENABLED=true` on the API and worker.",
      ],
    },
  ],
  image: homepage(
    "elevenlabs",
    "ElevenLabs",
    "The ElevenLabs homepage, headed Bringing technology to life, with a banner for Eleven v4.",
  ),
  faq: [
    {
      question: "How much does ElevenLabs cost?",
      answer:
        `As of November 2026, plans run from Free (${count(PLANS.free.credits)} credits, non-commercial) through Starter at ${usd(PLANS.starter.price)}, Creator at ${usd(PLANS.creator.price)}, Pro at ${usd(PLANS.pro.price)}, Scale at ${usd(PLANS.scale.price)} and Business at ${usd(PLANS.business.price)} a month. Through the API, Flash v2.5 costs ${usd(RATES.elevenlabsFlash / 1000)} per 1,000 characters (about ${FLASH_HOUR} per hour of speech) and Eleven v4 costs ${usd(RATES.elevenlabsV4 / 1000)}. Scribe v2 transcription is ${usd(RATES.elevenlabsScribeHour)} per hour.`,
    },
    {
      question: "How much does an ElevenLabs voice agent cost per month?",
      answer:
        `In Rakazo, a bot that reads 30 minutes of replies a day and transcribes 30 minutes of what you say costs ${aboutTotal("elevenlabs").toLowerCase()} a month in ElevenLabs usage. Rakazo doesn't add a voice charge. ElevenLabs' own Agents platform is priced separately, at ${usd(RATES.elevenlabsAgentsMinute)} a minute plus the language model.`,
    },
    {
      question: "Can I talk to my AI agent with ElevenLabs?",
      answer:
        "Yes. In Rakazo, connect ElevenLabs in **Settings → Voice**, then hold the mic to speak to a bot, have its replies read aloud, or call it in real time. ElevenLabs does the speech and transcription; the bot runs in Rakazo.",
    },
    {
      question: "Can a Rakazo bot use my cloned ElevenLabs voice?",
      answer:
        "Yes. Clone the voice in ElevenLabs, and it appears in Rakazo's voice picker with the rest of your account's voices. You can set it as your default or give it to one bot. Only clone voices you have the right to use.",
    },
    {
      question: "Which ElevenLabs model does Rakazo use?",
      answer:
        "Eleven Flash v2.5 (`eleven_flash_v2_5`) for speech, chosen for low latency in conversation, and Scribe v2 (`scribe_v2`) for transcription. You can enter another speech model, such as Eleven v4 (`eleven_v4`), in **Settings → Voice**; transcription always uses Scribe v2.",
    },
    {
      question: "What is the best ElevenLabs alternative?",
      answer:
        "For price, [Fish Audio](/voice-providers/fish-audio/) or a [self-hosted](/voice-providers/self-hosted/) Kokoro server. For fast calls, [Cartesia](/voice-providers/cartesia/). For a quick start with a key you have, [OpenAI](/voice-providers/openai/), until its speech model shuts down in January 2027. For transcription at scale outside Rakazo, Deepgram.",
    },
    {
      question: "Deepgram vs ElevenLabs: which is better?",
      answer:
        `Deepgram specializes in transcription and is a common choice for the listening side of voice agents, but per hour it is ${priceVersus(RATES.deepgramStreamHour, RATES.elevenlabsScribeRealtimeHour)} ElevenLabs: streaming Nova-3 costs ${usd(RATES.deepgramStreamHour)} against ${usd(RATES.elevenlabsScribeRealtimeHour)} for Scribe v2 Realtime, and batch ${usd(RATES.deepgramBatchHour)} against ${usd(RATES.elevenlabsScribeHour)}. ElevenLabs sounds more natural and clones voices; Deepgram's Aura-2 voices are ${priceVersus(RATES.deepgram, FLASH)} Flash v2.5. Many voice-agent builders use Deepgram to listen and ElevenLabs to speak. Rakazo connects to ElevenLabs but not Deepgram.`,
    },
    {
      question: "Do I need ElevenLabs to use Rakazo?",
      answer:
        "No. Voice is optional, and Rakazo works fully in text. On the mobile app, a bot can also use your phone's own voice for calls.",
    },
  ],
  sources: withPricingSources(
    [
    { label: "ElevenLabs", href: "https://elevenlabs.io" },
    PRICING_SOURCES.elevenlabs,
    PRICING_SOURCES.elevenlabsApi,
    { label: "ElevenLabs, models", href: "https://elevenlabs.io/docs/overview/models" },
    {
      label: "ElevenLabs, Pay As You Go",
      href: "https://elevenlabs.io/docs/overview/administration/pay-as-you-go",
    },
    {
      label: "ElevenLabs, zero retention mode",
      href: "https://elevenlabs.io/docs/developers/resources/zero-retention-mode",
    },
    VOICE_DOC,
    ],
    { prices: COMPARED, workload: WORKLOAD_SHOWN },
  ),
};
