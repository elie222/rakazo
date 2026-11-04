import type { VoiceProvider } from "./types";
import { VOICE_DOC, homepage } from "./shared";

export const elevenlabs: VoiceProvider = {
  slug: "elevenlabs",
  name: "ElevenLabs",
  does: "Speaks and transcribes",
  runs: "Hosted",
  bestFor: "The most natural voices, including ones you clone",
  title: "ElevenLabs for AI agents: talk to your Rakazo bots, and alternatives",
  description:
    "How to give AI agents an ElevenLabs voice in Rakazo: talk instead of typing, hear replies, and call your bots. Models, cloned voices, limits, setup and alternatives.",
  h1: "ElevenLabs for AI agents: give your bots a voice worth hearing",
  intro: [
    "[ElevenLabs](https://elevenlabs.io) is a voice AI company best known for natural, expressive text to speech and voice cloning. Its API also transcribes speech, so one key covers both directions of a conversation.",
    "[Rakazo](/) is an open source app for AI teammates that do real work. You talk to each bot in chat, and you can also talk to it by voice: hold the mic to speak, have replies read aloud, or call a bot in real time. Connect ElevenLabs and it does the speaking and the transcription. Rakazo runs the bot, decides what it says, and keeps the transcript in the chat.",
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
        "Its text to speech is known for sounding human, with emotion and natural pacing, in many languages. You can clone a voice from a recording, design a new one, or pick from a large shared voice library. Its Scribe models turn speech back into text. That combination is why it is often the first name people search when they want an AI agent that talks.",
      ],
      image: true,
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
        "Use your own voices. The voice picker lists the voices in your ElevenLabs account, including ones you cloned or saved from its library, and you can paste any voice ID.",
        "Send voice notes from chat apps. A voice note sent to a bot through Telegram, for example, is transcribed with ElevenLabs before the bot reads it. See [messaging apps](/docs/messaging-apps/).",
      ],
    },
    {
      heading: "When to choose ElevenLabs",
      paragraphs: [
        "Choose ElevenLabs when the voice itself matters: you'll listen to a bot every day, you want it to sound like a person, or you want it to sound like a specific person you have permission to clone. It is also the simplest choice for full voice support, since one key speaks and transcribes.",
        "[OpenAI](/voice-providers/openai/) also speaks and transcribes, and suits you if you already have an OpenAI key, though its speech models are scheduled to shut down. [Cartesia](/voice-providers/cartesia/) is built for fast, interruptible calls but only speaks. [Fish Audio](/voice-providers/fish-audio/) is another option with cloning and expressive speech. To keep audio on your own hardware, use a [self-hosted](/voice-providers/self-hosted/) speech server, or [macOS voices](/voice-providers/macos/) if your server runs on a Mac. The [comparison](/voice-providers/) puts them side by side.",
      ],
    },
    {
      heading: "Limits",
      bullets: [
        "Rakazo always speaks with Eleven Flash v2.5 (`eleven_flash_v2_5`), ElevenLabs' fast model for conversation. You can't switch to a more expressive model such as Eleven v4 from Rakazo.",
        "Rakazo doesn't clone voices itself. Create the clone in ElevenLabs first, then pick it in Rakazo.",
        "Each sentence is generated as a finished clip and played in order, rather than streamed word by word, so there is a short pause before the bot starts talking.",
        "Speech and transcription go through ElevenLabs' servers and use your ElevenLabs account's credit. If the account runs out, Rakazo tells you so instead of failing quietly.",
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
        "Eleven Flash v2.5 (`eleven_flash_v2_5`) for speech, chosen for low latency in conversation, and Scribe v2 (`scribe_v2`) for transcription. Neither can be changed in the app.",
    },
    {
      question: "What is a good ElevenLabs alternative for AI agents?",
      answer:
        "[OpenAI](/voice-providers/openai/) if you already have a key, [Cartesia](/voice-providers/cartesia/) for fast calls, or [Fish Audio](/voice-providers/fish-audio/) for cloning and expressive speech. To avoid a hosted service, run a [self-hosted](/voice-providers/self-hosted/) speech server.",
    },
    {
      question: "Do I need ElevenLabs to use Rakazo?",
      answer:
        "No. Voice is optional, and Rakazo works fully in text. The mobile app can also use your phone's own speech recognition and voices for calls.",
    },
  ],
  sources: [
    { label: "ElevenLabs", href: "https://elevenlabs.io" },
    { label: "ElevenLabs, models", href: "https://elevenlabs.io/docs/overview/models" },
    VOICE_DOC,
  ],
};
