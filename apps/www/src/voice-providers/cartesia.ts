import type { VoiceProvider } from "./types";
import { VOICE_DOC, homepage } from "./shared";

export const cartesia: VoiceProvider = {
  slug: "cartesia",
  name: "Cartesia",
  does: "Speaks only",
  runs: "Hosted",
  bestFor: "Fast, natural voices on calls",
  title: "Cartesia Sonic for AI agents: fast voices for Rakazo bots",
  description:
    "How Rakazo uses Cartesia Sonic so your AI agents can read replies aloud and talk on calls. How transcription works without it, cloned voices, limits and setup.",
  h1: "Cartesia Sonic for AI agents: quick voices for real conversations",
  intro: [
    "[Cartesia](https://cartesia.ai) builds speech models for live conversation. Its Sonic text to speech is designed to start talking almost immediately, which is what a voice agent needs when someone is waiting on the other end.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and you can also talk to it by voice: hold the mic to speak, have replies read aloud, or call a bot in real time. Connect Cartesia and it gives your bots their voice. Your device listens and turns your speech into text, and Rakazo runs the bot and keeps the transcript in the chat.",
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
        "Sonic voices sound natural in dozens of languages. You can choose from Cartesia's voice library or clone a voice from a short recording. Cartesia also sells a speech to text model, Ink, but Rakazo doesn't use it.",
      ],
      image: true,
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
        "If you need transcription from the provider too, pick one that does both. [ElevenLabs](/voice-providers/elevenlabs/) has the widest choice of voices and cloning, [OpenAI](/voice-providers/openai/) suits you if you already have a key, and [Fish Audio](/voice-providers/fish-audio/) adds expressive speech. To keep audio on your own hardware, run a [self-hosted](/voice-providers/self-hosted/) speech server, or use [macOS voices](/voice-providers/macos/) if your server runs on a Mac. The [comparison](/voice-providers/) puts them side by side.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        "No transcription. In a browser without on-device speech recognition, holding the mic shows an error until you switch to Chrome or the desktop app, or connect a provider that transcribes.",
        "Voice notes sent to a bot through a chat app such as Telegram arrive as audio files without a transcript.",
        "Rakazo always speaks with `sonic-3`. You can't pick a newer Sonic model or set emotion, speed or pronunciation from Rakazo.",
        "Each sentence is generated as a finished clip and played in order, rather than streamed over Cartesia's real-time connection, so a bot starts talking a little later than Sonic alone could.",
        "Rakazo doesn't clone voices itself. Create the clone in Cartesia first. The picker loads up to 2,000 voices, and voices beyond that can't be chosen.",
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
      question: "Can I build a voice agent with Cartesia Sonic?",
      answer:
        "Yes. In Rakazo, connect Cartesia in **Settings → Voice** and your bots speak with Sonic when they read replies or take a call. Your device turns your speech into text, so you don't need a second provider.",
    },
    {
      question: "Does Cartesia transcribe speech in Rakazo?",
      answer:
        "No. Cartesia sells a speech to text model, but Rakazo uses Cartesia only to speak. Listening uses your browser's, computer's or phone's speech recognition. For transcription from the provider, use [ElevenLabs](/voice-providers/elevenlabs/) or [OpenAI](/voice-providers/openai/).",
    },
    {
      question: "Can a Rakazo bot use my cloned Cartesia voice?",
      answer:
        "Yes. Clone the voice in Cartesia, and it appears in Rakazo's voice picker with the other voices your account can use. Only clone voices you have the right to use.",
    },
    {
      question: "Cartesia vs ElevenLabs for AI agents?",
      answer:
        "Both give Rakazo bots natural voices you can clone. Cartesia is built for speed in live conversation and only speaks in Rakazo. [ElevenLabs](/voice-providers/elevenlabs/) also transcribes, so the mic and chat app voice notes work everywhere with one key.",
    },
  ],
  sources: [
    { label: "Cartesia", href: "https://cartesia.ai" },
    {
      label: "Cartesia, Sonic models",
      href: "https://docs.cartesia.ai/build-with-cartesia/tts-models/latest",
    },
    VOICE_DOC,
  ],
};
