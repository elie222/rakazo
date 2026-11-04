import type { VoiceProvider } from "./types";
import {
  CHARS_PER_HOUR,
  CHARS_PER_MINUTE,
  PRICING_SOURCES,
  RATES,
  VOICE_DOC,
  WORKLOAD,
  WORKLOAD_CHARS,
  WORKLOAD_DAILY_MINUTES,
  cartesiaInkPerHour,
  CARTESIA_RANGE,
  cartesiaPerMillion,
  count,
  credits,
  homepage,
  perHourOfSpeech,
  priceVersus,
  usd,
  voicePriceTable,
  voiceWorkloadTable,
  withPricingSources,
} from "./shared";

const WORKLOAD_SHOWN = ["cartesia", "elevenlabs", "openai", "fish", "macos"] as const;
const COMPARED = ["cartesia", "elevenlabs", "openai", "fish", "deepgram", "inworld", "selfHosted"] as const;

const { pro, startup, scale } = RATES.cartesiaPlans;
const FREE_CREDITS = RATES.cartesiaFreeCredits;
/** Overage on the Pro plan for a month of this many characters. */
function onPro(chars: number): number {
  return (Math.max(0, chars - pro.credits) * pro.overage) / 1_000_000;
}
/** Characters a month for someone who hears 10 minutes a day, scaled from the worked example. */
const LIGHT_CHARS = (WORKLOAD_CHARS * 10) / WORKLOAD_DAILY_MINUTES;

const LOW = CARTESIA_RANGE.low;
const HIGH = CARTESIA_RANGE.high;

function planRow(plan: keyof typeof RATES.cartesiaPlans, label: string) {
  const perMillion = cartesiaPerMillion(plan);
  return {
    topic: label,
    cells: [usd(perMillion), perHourOfSpeech(perMillion), cartesiaInkPerHour(plan)],
  };
}

export const cartesia: VoiceProvider = {
  slug: "cartesia",
  name: "Cartesia",
  does: "Speaks only",
  runs: "Hosted",
  bestFor: "Fast, natural voices on calls",
  title: "Cartesia pricing and Cartesia vs ElevenLabs for AI voice agents (2026)",
  description:
    "Cartesia Sonic pricing explained: plans, credits, cost per hour of speech and Ink transcription, and how Cartesia compares with ElevenLabs on latency, price and cloning. How Rakazo uses Cartesia for calls, limits and setup.",
  h1: "Cartesia for AI agents: pricing, Cartesia vs ElevenLabs, and setup",
  intro: [
    "[Cartesia](https://cartesia.ai) builds speech models for live conversation. Its Sonic text to speech is designed to start talking almost immediately, which is what a voice agent needs when someone is waiting on the other end.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and you can also talk to it by voice: hold the mic to speak, have replies read aloud, or call a bot in real time. Connect Cartesia and it gives your bots their voice. Your device listens and turns your speech into text, and Rakazo runs the bot and keeps the transcript in the chat.",
    "This page covers Cartesia's plans and prices as of November 2026, what a bot that talks every day costs, how Cartesia compares with ElevenLabs, and what Rakazo does and doesn't use.",
  ],
  scene: {
    bot: "Sales Outbound",
    color: "#F5A03C",
    where: "Voice from Cartesia",
    ask: "call me when the overnight list is ready",
    reply: "will do. i'll ring you once the drafts are queued.",
    results: [
      { k: "Call", v: "rang you at 6:02am" },
      { k: "Decided", v: "send the 12 strongest drafts" },
      { k: "Decided", v: "hold the rest until Monday" },
      { k: "Transcript", v: "saved in this chat" },
    ],
  },
  sections: [
    {
      heading: "What is Cartesia?",
      paragraphs: [
        "[Cartesia](https://cartesia.ai) is a voice AI company that makes speech models and a platform for voice agents that answer and make phone calls. Its text to speech family is called Sonic, and it is built on state space models, an architecture Cartesia uses to keep latency low.",
        "As of November 2026 the newest model is Sonic 3.6, in 44 languages; Sonic 3 and 3.5 remain available. Cartesia advertises first audio in under 90 ms; independent tests over a real network have measured about 250 ms, still among the fastest. Emotion is inferred from the text, `[laughter]` can be inserted, and pronunciation dictionaries fix names. You can choose from Cartesia's voice library or clone a voice from about 10 seconds of audio. Cartesia also sells a speech to text model, Ink, but Rakazo doesn't use it.",
      ],
      image: true,
    },
    {
      heading: "Cartesia pricing in 2026",
      paragraphs: [
        `Cartesia sells monthly plans with credits. Sonic uses one credit per character, so about ${count(CHARS_PER_MINUTE)} credits per minute of speech at 150 words a minute, the pace every figure on this page assumes. Ink transcription uses 3 credits per second of audio. Unused credits roll over up to twice your monthly amount. With overage off, requests stop when credits run out; with it on, extra usage is billed per million credits.`,
      ],
      table: {
        caption: "Cartesia plans, as of November 2026",
        columns: [
          "Plan",
          "A month",
          "Credits a month",
          "Overage per 1M credits",
          "Voice cloning",
          "Speech requests at once",
        ],
        rows: [
          { topic: "Free", cells: ["$0", count(FREE_CREDITS), "None", "No", "2"] },
          {
            topic: "Pro",
            cells: [usd(pro.price), credits(pro.credits), usd(pro.overage), "Instant", "3"],
          },
          {
            topic: "Startup",
            cells: [
              usd(startup.price),
              credits(startup.credits),
              usd(startup.overage),
              "Instant, 2 Professional",
              "5",
            ],
          },
          {
            topic: "Scale",
            cells: [
              usd(scale.price),
              credits(scale.credits),
              usd(scale.overage),
              "Instant, 4 Professional",
              "15",
            ],
          },
          { topic: "Enterprise", cells: ["Custom", "Custom", "Custom", "Custom", "Custom"] },
        ],
        note: "From [Cartesia's pricing page](https://cartesia.ai/pricing), checked November 2026. Paid plans include commercial use; the page doesn't say for Free.",
      },
    },
    {
      heading: "Cartesia cost per hour of speech",
      paragraphs: [
        `Dividing each plan's price by its credits gives the effective rate. Smaller plans cost more per character, and the Free plan's ${count(FREE_CREDITS)} credits cover about ${Math.round(FREE_CREDITS / CHARS_PER_MINUTE)} minutes of speech a month. Cartesia's managed voice agents are priced separately at ${usd(RATES.cartesiaAgentsMinute)} a minute plus the language model and telephony.`,
      ],
      table: {
        caption: "Cartesia effective rates, as of November 2026",
        columns: ["Plan", "Speech per 1M characters", "About per hour of speech", "Ink per hour"],
        rows: [
          planRow("pro", "Pro"),
          planRow("startup", "Startup"),
          planRow("scale", "Scale"),
        ],
        note: `Derived from [Cartesia's pricing page](https://cartesia.ai/pricing), checked November 2026, at about ${count(CHARS_PER_HOUR)} characters per hour of speech. Rakazo doesn't use Ink.`,
      },
    },
    {
      heading: "What a talking Rakazo bot costs on Cartesia",
      paragraphs: [
        "Rakazo calls Cartesia with your key, so Cartesia bills you and Rakazo adds nothing. Because Rakazo uses Cartesia only to speak, transcription is free: your browser, the desktop app or your phone does the listening.",
        `${WORKLOAD} That is about ${count(WORKLOAD_CHARS)} credits, which fits inside the Startup plan's ${count(startup.credits)}: ${usd(startup.price)} a month. On Pro you'd pay ${usd(pro.price)} plus about $${Math.round(onPro(WORKLOAD_CHARS))} of overage, so Startup is the better fit at this volume. Someone who hears 10 minutes a day uses about ${count(LIGHT_CHARS)} credits, which is Pro plus about $${Math.round(onPro(LIGHT_CHARS))} of overage.`,
      ],
      table: voiceWorkloadTable("One bot, 30 minutes of speech and 30 of transcription a day", WORKLOAD_SHOWN),
    },
    {
      heading: "Cartesia vs ElevenLabs",
      paragraphs: [
        `Both make natural, clonable voices for agents. Per character, Cartesia on its Startup plan is ${priceVersus(cartesiaPerMillion("startup"), RATES.elevenlabsFlash)} ElevenLabs Flash v2.5: Cartesia costs ${usd(LOW)} to ${usd(HIGH)} per million depending on plan, ElevenLabs ${usd(RATES.elevenlabsFlash)}. The differences are elsewhere. Cartesia is designed around latency, and in tests with lots of interruptions the difference is noticeable. ElevenLabs has the larger voice library, the more expressive top model (Eleven v4), and its own transcription. Reviewers rate Cartesia's English highly but say other languages trail ElevenLabs.`,
        "In Rakazo the practical difference is transcription: ElevenLabs does both directions with one key, while Cartesia only speaks, so the mic depends on your device's speech recognition.",
      ],
      table: voicePriceTable("Cartesia compared with ElevenLabs and other voice APIs", COMPARED),
    },
    {
      heading: "What you can do with Cartesia in Rakazo",
      paragraphs: [
        "In Rakazo, Cartesia speaks and doesn't transcribe. Everything that needs a voice works with it, and your device handles listening. The [voice and calls guide](/docs/voice-and-calls/) shows where each control lives.",
      ],
      bullets: [
        "Hear replies. Choose **Speak this reply** on any message, or turn on **Read replies aloud** in a bot's settings. Replies are spoken with `sonic-3`.",
        "Call a bot. Choose **Call** at the top of a chat to talk in real time. You can cut in while the bot is speaking, and the transcript stays in the chat.",
        "Get called. Ask \"call me when the overnight list is ready\" and the bot rings you. A bot may also call if you've missed the same reminder several times.",
        "Give each bot its own voice. The **Voice** next to **Read replies aloud** overrides your default for that bot.",
        "Use your own voices. The voice picker lists the voices your Cartesia account can use, including ones you cloned.",
        "Talk instead of typing, with your device's speech recognition. Holding the mic uses the browser's recognition in Chrome and the system's in the desktop app. On calls in the mobile app, the phone listens.",
      ],
    },
    {
      heading: "When to choose Cartesia",
      paragraphs: [
        "Choose Cartesia when you mostly listen to your bots and call them, and you want voices that sound natural and start quickly. It fits people who use Chrome, the desktop app or the mobile app, where speech recognition is already on the device.",
        "If you need transcription from the provider too, pick one that does both. [ElevenLabs](/voice-providers/elevenlabs/) has the widest choice of voices and cloning, [OpenAI](/voice-providers/openai/) suits you if you already have a key, and [Fish Audio](/voice-providers/fish-audio/) adds expressive speech at a lower price. To keep audio on your own hardware, run a [self-hosted](/voice-providers/self-hosted/) speech server, or use [Server (Mac)](/voice-providers/macos/) if your server runs on a Mac. The [comparison](/voice-providers/) puts them side by side.",
      ],
    },
    {
      heading: "Limits and gotchas",
      bullets: [
        "No transcription. In a browser without on-device speech recognition, holding the mic shows an error until you switch to Chrome or the desktop app, or connect a provider that transcribes.",
        "Voice notes sent to a bot through a chat app such as Telegram arrive as audio files without a transcript.",
        "Rakazo always speaks with `sonic-3`. You can't pick Sonic 3.6 or set emotion, speed or pronunciation from Rakazo.",
        "Each sentence is generated as a finished clip and played in order, rather than streamed over Cartesia's real-time connection, so a bot starts talking a little later than Sonic alone could.",
        "Rakazo doesn't clone voices itself. Create the clone in Cartesia first. The picker loads up to 2,000 voices, and voices beyond that can't be chosen.",
        "Speech requests at once are capped per plan, from 2 on Free to 15 on Scale. Several people sharing one key on calls can hit that.",
        "Zero data retention, HIPAA agreements and regional endpoints in the EU, UK, India and Australia are Enterprise features. Cartesia is SOC 2 Type II certified.",
        "Calls and hold-to-talk are a server setting. On a self-hosted server they stay off until the admin turns them on.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "Anyone can do this in their own settings, on Rakazo Cloud or a self-hosted server. The key belongs to your account, not the whole server.",
      ],
      steps: [
        "Create an API key in your [Cartesia](https://cartesia.ai) account.",
        "In Rakazo, open **Settings → Voice**, choose **Cartesia** as the **Provider**, paste the **API key** and choose **Connect**.",
        "Pick a **Voice** and use **Hear a sample** to check it.",
        "Optionally, open a bot's settings, expand **Advanced**, turn on **Read replies aloud** and give it its own **Voice**.",
        "If you run your own server and want calls and hold-to-talk, set `PHONE_CALLS_ENABLED=true` on the API and worker.",
      ],
    },
  ],
  image: homepage(
    "cartesia",
    "Cartesia",
    "The Cartesia homepage, headed #1-ranked for realtime voice. Models and agents built on frontier research.",
  ),
  faq: [
    {
      question: "How much does Cartesia cost?",
      answer:
        `As of November 2026, Cartesia has a Free plan with ${count(FREE_CREDITS)} credits a month, Pro at ${usd(pro.price)} for ${credits(pro.credits)}, Startup at ${usd(startup.price)} for ${credits(startup.credits)} and Scale at ${usd(scale.price)} for ${credits(scale.credits)}. Sonic uses one credit per character, so speech costs about ${usd(LOW)} to ${usd(HIGH)} per million characters, roughly ${perHourOfSpeech(LOW)} to ${perHourOfSpeech(HIGH)} per hour.`,
    },
    {
      question: "Cartesia vs ElevenLabs: which is better for AI agents?",
      answer:
        "Both give natural voices you can clone, at a similar price per character. Cartesia is built for speed in live conversation. [ElevenLabs](/voice-providers/elevenlabs/) has more voices and languages and also transcribes, so in Rakazo the mic and chat app voice notes work everywhere with one key. Cartesia only speaks in Rakazo.",
    },
    {
      question: "Can I build a voice agent with Cartesia Sonic?",
      answer:
        "Yes. In Rakazo, connect Cartesia in **Settings → Voice** and your bots speak with Sonic when they read replies or take a call. Your device turns your speech into text, so you don't need a second provider.",
    },
    {
      question: "Does Cartesia transcribe speech in Rakazo?",
      answer:
        "No. Cartesia sells a speech to text model, Ink, but Rakazo uses Cartesia only to speak. Listening uses your browser's, computer's or phone's speech recognition. For transcription from the provider, use [ElevenLabs](/voice-providers/elevenlabs/), [OpenAI](/voice-providers/openai/) or [Fish Audio](/voice-providers/fish-audio/).",
    },
    {
      question: "Can a Rakazo bot use my cloned Cartesia voice?",
      answer:
        "Yes. Clone the voice in Cartesia, and it appears in Rakazo's voice picker with the other voices your account can use. Only clone voices you have the right to use.",
    },
    {
      question: "Is Cartesia open source?",
      answer:
        "No. Sonic and Ink are hosted models; Enterprise customers can arrange on-premises deployment through sales. For open models, see [self-hosted voice](/voice-providers/self-hosted/).",
    },
  ],
  sources: withPricingSources(
    [
    { label: "Cartesia", href: "https://cartesia.ai" },
    PRICING_SOURCES.cartesia,
    {
      label: "Cartesia, Sonic models",
      href: "https://docs.cartesia.ai/build-with-cartesia/tts-models/latest",
    },
    {
      label: "eesel, Cartesia Sonic 3 vs ElevenLabs",
      href: "https://www.eesel.ai/blog/cartesia-sonic-3-vs-elevenlabs",
    },
    VOICE_DOC,
    ],
    { prices: COMPARED, workload: WORKLOAD_SHOWN },
  ),
};
