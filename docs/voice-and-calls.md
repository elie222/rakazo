# Voice and calls

Talk to your bots instead of typing, have them read replies aloud, or call them.

## Set up a voice provider

Open **Settings → Voice**, pick a **Provider** and add its **API key**:

- **ElevenLabs**, **OpenAI** and **Fish Audio** can speak and transcribe.
- **Cartesia** speaks only.
- **Self-hosted** uses your own OpenAI-compatible speech server, such as Kokoro or Whisper. Enter its
  **Server URL**.
- **macOS** uses the voices installed on the Mac running your server, with no key. It appears only
  when the server runs on a Mac.

Then choose a **Voice**, and use **Hear a sample** to check it. **Speech model** and
**Transcription model** let you pick the provider's models.

Voice settings apply to every [space](./spaces.md). A space can customize them in its settings.

## Talk instead of typing

Hold the microphone in the composer and speak; release to send. Slide up to lock recording so you
don't have to keep holding.

## Hear replies

- To hear one reply, choose **Speak this reply** on the message.
- To hear every reply from a bot, open its settings, expand **Advanced**, and turn on
  **Read replies aloud**. The **Voice** next to it overrides your default voice for that bot.

## Call a bot

Choose **Call** at the top of the chat to talk with the bot in real time. During a call you can
**Mute**, open the **Transcript**, minimize the call and keep using the app, or **Hang up**. The
transcript stays in the chat afterwards.

Bots can call you too: ask "call me at 5 to go over the day", or a bot may call when you've missed
the same reminder several times. You'll see that the bot is calling you; answer or **Decline**. A
missed call shows **Call back** in the chat.

## On mobile

The mobile app uses your phone's own speech recognition and voices for calls. Pick a
**Device voice** in a bot's settings. On Android, a call keeps going with the screen off.
