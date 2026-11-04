import type { VoiceProvider } from "./types";
import { VOICE_DOC, homepage } from "./shared";

export const openai: VoiceProvider = {
  slug: "openai",
  name: "OpenAI",
  does: "Speaks and transcribes",
  runs: "Hosted",
  bestFor: "Reusing an OpenAI key you already have",
  title: "OpenAI text to speech for AI agents: voice for Rakazo bots",
  description:
    "How Rakazo uses OpenAI text to speech and transcription so you can talk to your AI agents, hear replies and call them. Models, the 2027 shutdown, limits and setup.",
  h1: "OpenAI text to speech for AI agents: voice with the key you have",
  intro: [
    "[OpenAI](https://openai.com) is best known for ChatGPT and its language models, and its API also turns text into speech and speech into text. If you already pay for OpenAI, the same kind of API key can give your agents a voice.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and you can also talk to it by voice: hold the mic to speak, have replies read aloud, or call a bot in real time. Connect OpenAI and it does the speaking and the transcription. Rakazo runs the bot, decides what it says, and keeps the transcript in the chat.",
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
        "OpenAI has announced that its current speech models, including `gpt-4o-mini-tts`, shut down on January 6, 2027. Its replacement, `gpt-realtime-2.1-mini`, works through the Realtime API instead of the speech endpoint. The `gpt-4o-mini-transcribe` transcription model follows on February 26, 2027.",
      ],
      image: true,
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
        "Choose OpenAI when you already have an OpenAI account and want voice working in a few minutes, with clear voices and solid transcription from one key. Because its speech models are scheduled to shut down, treat it as a convenient start rather than a long-term pick, until Rakazo moves to OpenAI's newer models.",
        "[ElevenLabs](/voice-providers/elevenlabs/) also speaks and transcribes, with more natural voices and support for your own cloned ones. [Cartesia](/voice-providers/cartesia/) is built for fast, interruptible calls but only speaks. [Fish Audio](/voice-providers/fish-audio/) offers cloning and expressive speech. If you like OpenAI's API shape but want audio on your own hardware, a [self-hosted](/voice-providers/self-hosted/) server such as Kokoro or Whisper speaks the same protocol. [macOS voices](/voice-providers/macos/) need no key when your server runs on a Mac. The [comparison](/voice-providers/) puts them side by side.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        "Rakazo speaks with `gpt-4o-mini-tts`, which OpenAI shuts down on January 6, 2027, and transcribes with `gpt-4o-mini-transcribe`, which follows on February 26, 2027. Until Rakazo moves to newer models, OpenAI voice stops working on those dates.",
        "The models are fixed. You can't choose `tts-1`, a newer model or a different transcription model from Rakazo.",
        "Rakazo offers OpenAI's 13 built-in voices. It doesn't send tone instructions, and custom voices made in your OpenAI account aren't supported.",
        "Each sentence is generated as a finished clip and played in order, rather than streamed, so there is a short pause before the bot starts talking.",
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
      question: "Can I use OpenAI text to speech for an AI agent?",
      answer:
        "Yes. In Rakazo, connect OpenAI in **Settings → Voice** and your bots can read replies aloud, take calls and transcribe what you say. Note that OpenAI shuts down its current speech models on January 6, 2027.",
    },
    {
      question: "Is gpt-4o-mini-tts being deprecated?",
      answer:
        "Yes. OpenAI says `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts` shut down on January 6, 2027, and points to `gpt-realtime-2.1-mini` through the Realtime API. Rakazo uses `gpt-4o-mini-tts` today, so OpenAI voice in Rakazo depends on moving to the new model before then.",
    },
    {
      question: "Which OpenAI voices can a Rakazo bot use?",
      answer:
        "The 13 built-in voices: Alloy, Ash, Ballad, Cedar, Coral, Echo, Fable, Marin, Nova, Onyx, Sage, Shimmer and Verse. You can set a default and a different voice per bot.",
    },
    {
      question: "OpenAI vs ElevenLabs for voice agents?",
      answer:
        "Both speak and transcribe in Rakazo. OpenAI is convenient if you already have a key and offers a fixed set of voices. [ElevenLabs](/voice-providers/elevenlabs/) sounds more natural, lets you use voices you clone, and isn't affected by OpenAI's 2027 shutdown.",
    },
    {
      question: "Can I use a self-hosted Whisper server instead?",
      answer:
        "Yes, where your server offers it. Choose [Self-hosted](/voice-providers/self-hosted/) in **Settings → Voice** and enter the address of any OpenAI-compatible speech server, such as Kokoro for speech or Whisper for transcription.",
    },
  ],
  sources: [
    {
      label: "OpenAI, text to speech",
      href: "https://developers.openai.com/api/docs/guides/text-to-speech",
    },
    { label: "OpenAI, deprecations", href: "https://developers.openai.com/api/docs/deprecations" },
    VOICE_DOC,
  ],
};
