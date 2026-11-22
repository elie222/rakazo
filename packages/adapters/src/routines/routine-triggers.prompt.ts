/** Where the user finds what a sender needs; the key itself never reaches the bot. */
export const ROUTINE_WEBHOOK_SETUP_NOTE =
  "The user copies the URL and key from this routine in Routines on the web or desktop app, or a webhook's from the routine's row in its chat. Never ask them for the key.";

/** A chat trigger takes each message in that app, so the bot stops replying there as usual. */
export const ROUTINE_CHAT_TRIGGER_NOTE =
  "Each message the bot receives in that chat app now starts this routine instead of a normal reply, until it is paused or removed.";
