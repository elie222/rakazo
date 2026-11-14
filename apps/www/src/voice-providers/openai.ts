import type { VoiceProvider } from "./types";
import {
  CHARS_PER_HOUR,
  OPENAI_MINI_TTS,
  PRICING_SOURCES,
  RATES,
  VOICE_DOC,
  WORKLOAD,
  WORKLOAD_COST,
  aboutTotal,
  count,
  homepage,
  perHourOfSpeech,
  priceVersus,
  speechHourCost,
  usd,
  voicePriceTable,
  voiceWorkloadTable,
  withPricingSources,
} from "./shared";

const WORKLOAD_SHOWN = ["openai", "elevenlabs", "fish", "cartesia", "selfHosted"] as const;
const COMPARED = ["openai", "openaiTts1", "elevenlabs", "cartesia", "fish", "deepgram", "google", "selfHosted"] as const;

const TRANSCRIBE = RATES.openaiTranscribeMinute;
const MINI_TTS_HOUR = RATES.openaiMiniTtsMinute * 60;
/** Whether OpenAI is the cheapest hosted option in Rakazo for the worked example. */
const CHEAPEST_HOSTED = (["elevenlabs", "cartesia", "fish", "xai"] as const).every(
  (other) =>
    WORKLOAD_COST.openai.speech + WORKLOAD_COST.openai.transcription <
    WORKLOAD_COST[other].speech + WORKLOAD_COST[other].transcription,
);
/** A per-minute price as published, which can run to tenths of a cent ("$0.0045"). */
function perMinute(price: number): string {
  return `$${price}`;
}
function transcribeRow(topic: string, minute: number) {
  return { topic, cells: [`${perMinute(minute)} a minute`, usd(minute * 60)] };
}
const MINI_TTS_TOKENS = `${usd(RATES.openaiMiniTtsTextIn)} per 1M text tokens in, ${usd(RATES.openaiMiniTtsAudioOut)} per 1M audio tokens out`;

export const openai: VoiceProvider = {
  slug: "openai",
  name: "OpenAI",
  does: "Speaks and transcribes",
  runs: "Hosted",
  bestFor: "Reusing an OpenAI key you already have",
  title: "OpenAI TTS pricing, the gpt-4o-mini-tts shutdown and alternatives for AI agents",
  description:
    "OpenAI text to speech and transcription pricing in 2026: gpt-4o-mini-tts, tts-1, Whisper and gpt-4o-mini-transcribe per hour, the January 2027 shutdown and its replacement, and how it compares with ElevenLabs and others. Setup in Rakazo.",
  h1: "OpenAI text to speech for AI agents: pricing, shutdown dates and setup",
  intro: [
    "[OpenAI](https://openai.com) is best known for ChatGPT and its language models, and its API also turns text into speech and speech into text. If you already pay for OpenAI, the same kind of API key can give your agents a voice.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and you can also talk to it by voice: hold the mic to speak, have replies read aloud, or call a bot in real time. Connect OpenAI and it does the speaking and the transcription. Rakazo runs the bot, decides what it says, and keeps the transcript in the chat.",
    "This page covers what OpenAI's audio models cost as of November 2026, the shutdown of `gpt-4o-mini-tts` and the transcription models in early 2027, and how OpenAI compares with the alternatives.",
  ],
  scene: {
    bot: "Inbox Manager",
    color: "#6A6BF5",
    where: "Voice from OpenAI",
    ask: "anything urgent in my inbox? draft replies, don't send",
    reply: "three need you today. drafts are ready, nothing sent. reading the first one now.",
    results: [
      { k: "Voice message", v: "transcribed" },
      { k: "Gmail", v: "3 urgent threads found" },
      { k: "Gmail", v: "3 replies drafted, not sent" },
      { k: "Reply", v: "read aloud in Marin" },
    ],
  },
  sections: [
    {
      heading: "What is OpenAI text to speech?",
      paragraphs: [
        "OpenAI's [Audio API](https://developers.openai.com/api/docs/guides/text-to-speech) has a speech endpoint that reads text aloud in one of 13 built-in voices, such as Alloy, Coral, Marin and Cedar, and a transcription endpoint that turns a recording into text. Both are reached with an ordinary OpenAI API key.",
        "The speech endpoint takes up to 4,096 characters per request and returns MP3, Opus, AAC, FLAC, WAV or raw PCM. With `gpt-4o-mini-tts` you can also pass instructions for tone, accent and pace. OpenAI says the voices are optimized for English, though they follow Whisper's language coverage.",
      ],
      image: true,
    },
    {
      heading: "gpt-4o-mini-tts and Whisper are being shut down",
      paragraphs: [
        "OpenAI's [deprecations page](https://developers.openai.com/api/docs/deprecations) says `tts-1`, `tts-1-hd` and both snapshots of `gpt-4o-mini-tts` shut down on January 6, 2027. The replacement, `gpt-realtime-2.1-mini`, isn't supported on the speech endpoint: it works through the Realtime API over WebRTC, WebSocket or SIP. Developers on OpenAI's forum point out that a realtime model has to be prompted to read text exactly, which a speech endpoint never needed.",
        "Transcription follows on February 26, 2027: `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and `gpt-4o-transcribe-diarize` all shut down, replaced by `gpt-transcribe` and `gpt-live-transcribe`.",
        "Rakazo speaks with `gpt-4o-mini-tts` and transcribes with `gpt-4o-mini-transcribe` today. Until Rakazo moves to the newer models, OpenAI voice in Rakazo stops working on those dates.",
      ],
      table: {
        caption: "OpenAI audio models and their shutdown dates",
        columns: ["Model", "Used for", "Shuts down", "Replacement"],
        rows: [
          {
            topic: "`gpt-4o-mini-tts` (Rakazo uses this)",
            cells: ["Speech", "January 6, 2027", "`gpt-realtime-2.1-mini`, Realtime API only"],
          },
          {
            topic: "`tts-1`, `tts-1-hd`",
            cells: ["Speech", "January 6, 2027", "`gpt-realtime-2.1-mini`"],
          },
          {
            topic: "`gpt-4o-mini-transcribe` (Rakazo uses this)",
            cells: ["Transcription", "February 26, 2027", "`gpt-transcribe` or `gpt-live-transcribe`"],
          },
          {
            topic: "`whisper-1`, `gpt-4o-transcribe`",
            cells: ["Transcription", "February 26, 2027", "`gpt-transcribe` or `gpt-live-transcribe`"],
          },
        ],
        note: "From [OpenAI's deprecations page](https://developers.openai.com/api/docs/deprecations), checked November 2026.",
      },
    },
    {
      heading: "OpenAI TTS pricing",
      paragraphs: [
        `OpenAI has no free tier for audio; you prepay API credit. The older speech models are billed per character, and the newer ones per token, which is why people find the pricing confusing. \`gpt-4o-mini-tts\` charges for the text you send and, much more, for the audio it returns. OpenAI used to estimate that at about ${perMinute(RATES.openaiMiniTtsMinute)} a minute; its pricing page no longer gives a per-minute figure, and some developers report bills above that estimate.`,
      ],
      table: {
        caption: "OpenAI speech and transcription prices, as of November 2026",
        columns: ["Model", "Price", "About per hour"],
        rows: [
          {
            topic: "`gpt-4o-mini-tts`",
            cells: [
              MINI_TTS_TOKENS,
              `About ${OPENAI_MINI_TTS.perHour}`,
            ],
          },
          {
            topic: "`tts-1`",
            cells: [`${usd(RATES.openaiTts1)} per 1M characters`, perHourOfSpeech(RATES.openaiTts1)],
          },
          {
            topic: "`tts-1-hd`",
            cells: [`${usd(RATES.openaiTts1Hd)} per 1M characters`, perHourOfSpeech(RATES.openaiTts1Hd)],
          },
          {
            topic: "`gpt-realtime-2.1-mini`",
            cells: [
              `${usd(RATES.openaiRealtimeMiniAudioIn)} per 1M audio tokens in, ${usd(RATES.openaiRealtimeMiniAudioOut)} per 1M audio tokens out`,
              "Not published",
            ],
          },
          transcribeRow("`gpt-4o-mini-transcribe`", TRANSCRIBE.mini),
          transcribeRow("`gpt-transcribe`", TRANSCRIBE.gpt),
          transcribeRow("`gpt-4o-transcribe`, Whisper", TRANSCRIBE.gpt4o),
          transcribeRow("`gpt-live-transcribe`", TRANSCRIBE.live),
        ],
        note: `From [OpenAI's API pricing page](https://developers.openai.com/api/docs/pricing), checked November 2026. Hourly speech figures assume about ${count(CHARS_PER_HOUR)} characters an hour; the \`gpt-4o-mini-tts\` figure uses OpenAI's earlier estimate of $${RATES.openaiMiniTtsMinute} a minute.`,
      },
    },
    {
      heading: "What a talking Rakazo bot costs on OpenAI",
      paragraphs: [
        "Rakazo calls OpenAI with your key, so OpenAI bills you and Rakazo adds nothing. The voice key is stored separately from any OpenAI key you use for models, but both draw on the same OpenAI account if you use the same project.",
        `${WORKLOAD} On OpenAI that is about ${usd(WORKLOAD_COST.openai.speech)} of speech and ${usd(WORKLOAD_COST.openai.transcription)} of transcription: ${aboutTotal("openai").toLowerCase()} a month, ${CHEAPEST_HOSTED ? "the cheapest hosted option in Rakazo" : "among the cheaper hosted options"}, until the shutdown.`,
      ],
      table: voiceWorkloadTable("One bot, 30 minutes of speech and 30 of transcription a day", WORKLOAD_SHOWN),
    },
    {
      heading: "OpenAI TTS vs ElevenLabs and other voice APIs",
      paragraphs: [
        "OpenAI is cheap and simple, with a small fixed set of voices. ElevenLabs and Fish Audio sound more natural to most listeners and let you use cloned voices; Cartesia is faster to start talking. OpenAI's custom voices exist but are limited to eligible customers through sales, and Rakazo doesn't use them.",
      ],
      table: voicePriceTable("OpenAI compared with other voice APIs", COMPARED),
    },
    {
      heading: "What you can do with OpenAI in Rakazo",
      paragraphs: [
        "OpenAI both speaks and transcribes, so it covers every voice feature in Rakazo. The [voice and calls guide](/docs/voice-and-calls/) shows where each control lives.",
      ],
      bullets: [
        "Talk instead of typing. Hold the mic in the composer, speak, and let go to send. When Rakazo transcribes on the server, as it does in a phone browser or the desktop app, it uses `gpt-4o-mini-transcribe`.",
        "Hear replies. Choose **Speak this reply** on any message, or turn on **Read replies aloud** in a bot's settings. Replies are spoken with `gpt-4o-mini-tts`.",
        "Call a bot. Choose **Call** at the top of a chat to talk in real time. You can cut in while the bot is speaking, and the transcript stays in the chat.",
        "Get called. Ask \"call me when the drafts are ready\" and the bot rings you. A bot may also call if you've missed the same reminder several times.",
        "Give each bot its own voice. Pick from OpenAI's 13 voices per bot, so different bots are easy to tell apart.",
        "Send voice notes from chat apps. A voice note sent to a bot through Telegram, for example, is transcribed before the bot reads it. See [messaging apps](/docs/messaging-apps/).",
      ],
    },
    {
      heading: "When to choose OpenAI",
      paragraphs: [
        "Choose OpenAI when you already have an OpenAI account and want voice working in a few minutes, with clear voices and solid transcription from one key at a low price. Because its speech and transcription models are scheduled to shut down, treat it as a convenient start rather than a long-term pick, until Rakazo moves to OpenAI's newer models.",
        "[ElevenLabs](/voice-providers/elevenlabs/) also speaks and transcribes, with more natural voices and support for your own cloned ones. [Cartesia](/voice-providers/cartesia/) is built for fast, interruptible calls but only speaks. [Fish Audio](/voice-providers/fish-audio/) offers cloning and expressive speech at a similar price to OpenAI. If you like OpenAI's API shape but want audio on your own hardware, a [self-hosted](/voice-providers/self-hosted/) server such as Kokoro or Whisper speaks the same protocol. [Server (Mac)](/voice-providers/macos/) needs no key when your server runs on a Mac. The [comparison](/voice-providers/) puts them side by side.",
      ],
    },
    {
      heading: "Limits and gotchas",
      bullets: [
        "Rakazo speaks with `gpt-4o-mini-tts`, which OpenAI shuts down on January 6, 2027, and transcribes with `gpt-4o-mini-transcribe`, which follows on February 26, 2027. Until Rakazo moves to newer models, OpenAI voice stops working on those dates.",
        "The models are fixed. You can't choose `tts-1`, a newer model or a different transcription model from Rakazo.",
        "Rakazo offers OpenAI's 13 built-in voices. It doesn't send tone instructions, and custom voices made in your OpenAI account aren't supported.",
        "Each sentence is generated as a finished clip and played in order, rather than streamed, so there is a short pause before the bot starts talking.",
        "OpenAI keeps speech requests for up to 30 days for abuse monitoring and doesn't train on API data by default. Transcription requests aren't retained. Zero data retention needs OpenAI's approval.",
        "OpenAI's usage policies ask you to tell listeners the voice is AI-generated. Keep that in mind if a bot's voice reaches people outside your team.",
        "Calls and hold-to-talk are a server setting. On a self-hosted server they stay off until the admin turns them on.",
      ],
    },
    {
      heading: "How to set it up",
      paragraphs: [
        "Anyone can do this in their own settings, on Rakazo Cloud or a self-hosted server. The key belongs to your account, and it is stored separately from any OpenAI key you use for models, so paste it here even if you already added it elsewhere.",
      ],
      steps: [
        "Create an API key in the [OpenAI platform](https://platform.openai.com) for a project with audio access.",
        "In Rakazo, open **Settings → Voice**, choose **OpenAI** as the **Provider**, paste the **API key** and choose **Connect**.",
        "Pick a **Voice**, such as Marin or Cedar, and use **Hear a sample** to check it.",
        "Optionally, open a bot's settings, expand **Advanced**, turn on **Read replies aloud** and give it its own **Voice**.",
        "If you run your own server and want calls and hold-to-talk, set `PHONE_CALLS_ENABLED=true` on the API and worker.",
      ],
    },
  ],
  image: {
    ...homepage(
      "openai",
      "OpenAI",
      "OpenAI's text to speech guide, with a notice that tts-1, tts-1-hd and gpt-4o-mini-tts shut down on January 6, 2027.",
    ),
    caption: "OpenAI's text to speech guide.",
  },
  faq: [
    {
      question: "How much does OpenAI text to speech cost?",
      answer:
        `As of November 2026, \`tts-1\` costs ${usd(RATES.openaiTts1)} and \`tts-1-hd\` ${usd(RATES.openaiTts1Hd)} per million characters. \`gpt-4o-mini-tts\` costs ${usd(RATES.openaiMiniTtsTextIn)} per million text tokens in and ${usd(RATES.openaiMiniTtsAudioOut)} per million audio tokens out, which OpenAI used to estimate at about ${perMinute(RATES.openaiMiniTtsMinute)} a minute, roughly ${OPENAI_MINI_TTS.perHour} an hour. There is no free tier.`,
    },
    {
      question: "How much does the Whisper API cost?",
      answer:
        `Whisper and \`gpt-4o-transcribe\` cost ${perMinute(TRANSCRIBE.gpt4o)} a minute (${usd(RATES.openaiWhisperHour)} an hour), \`gpt-4o-mini-transcribe\` ${perMinute(TRANSCRIBE.mini)} a minute, and the newer \`gpt-transcribe\` ${perMinute(TRANSCRIBE.gpt)} a minute. Whisper and the gpt-4o transcription models shut down on February 26, 2027.`,
    },
    {
      question: "Is gpt-4o-mini-tts being deprecated?",
      answer:
        "Yes. OpenAI says `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts` shut down on January 6, 2027, and points to `gpt-realtime-2.1-mini` through the Realtime API. Rakazo uses `gpt-4o-mini-tts` today, so OpenAI voice in Rakazo depends on moving to the new model before then.",
    },
    {
      question: "Can I use OpenAI text to speech for an AI agent?",
      answer:
        "Yes. In Rakazo, connect OpenAI in **Settings → Voice** and your bots can read replies aloud, take calls and transcribe what you say. Note the shutdown dates above.",
    },
    {
      question: "Which OpenAI voices can a Rakazo bot use?",
      answer:
        "The 13 built-in voices: Alloy, Ash, Ballad, Cedar, Coral, Echo, Fable, Marin, Nova, Onyx, Sage, Shimmer and Verse. You can set a default and a different voice per bot.",
    },
    {
      question: "OpenAI vs ElevenLabs for voice agents?",
      answer:
        `Both speak and transcribe in Rakazo. Per hour of speech, OpenAI is ${priceVersus(MINI_TTS_HOUR, speechHourCost(RATES.elevenlabsFlash))} ElevenLabs Flash v2.5, around ${OPENAI_MINI_TTS.perHour} against ${perHourOfSpeech(RATES.elevenlabsFlash)}, and offers a fixed set of voices. [ElevenLabs](/voice-providers/elevenlabs/) sounds more natural, lets you use voices you clone, and isn't affected by OpenAI's 2027 shutdown.`,
    },
    {
      question: "Can I use a self-hosted Whisper server instead?",
      answer:
        "Yes, where your server offers it. Choose [Self-hosted](/voice-providers/self-hosted/) in **Settings → Voice** and enter the address of any OpenAI-compatible speech server, such as Kokoro for speech or Whisper for transcription.",
    },
  ],
  sources: withPricingSources(
    [
    {
      label: "OpenAI, text to speech",
      href: "https://developers.openai.com/api/docs/guides/text-to-speech",
    },
    { label: "OpenAI, deprecations", href: "https://developers.openai.com/api/docs/deprecations" },
    PRICING_SOURCES.openai,
    { label: "OpenAI, your data", href: "https://developers.openai.com/api/docs/guides/your-data" },
    {
      label: "OpenAI community, TTS shutdown email",
      href: "https://community.openai.com/t/tts-shutdown-email-tts-1-gpt-4o-mini-tts-jan-6-2027-isnt-on-the-deprecations-page/1402731",
    },
    VOICE_DOC,
    ],
    { prices: COMPARED, workload: WORKLOAD_SHOWN },
  ),
};
