# Mobile app

Chat with your bots, answer their questions, watch their computers and take calls from your phone.

## Install

- iPhone, iPhone Duo and iPad: [App Store](https://apps.apple.com/app/rakazo/id6801531099).
- Android: [Google Play](https://play.google.com/store/apps/details?id=com.rakazo.app).

You can also choose **Get the mobile app** from the account menu in the web or desktop app.

## Sign in

Sign in with your rakazo.com account. To use your own server instead, tap **Use a custom server** on
the sign-in screen and enter its address. For a server on your local network, follow
[Connecting a phone on the same network](./self-host-clients.md#connecting-a-phone-on-the-same-network);
over Tailscale, follow [Connecting a phone over Tailscale](./self-host-clients.md#connecting-a-phone-over-tailscale).
The desktop app's **This computer** server can't be reached from a phone; see
[Desktop "This computer" servers](./self-host-clients.md#desktop-this-computer-servers).

Custom servers you switch to or away from are listed on that screen, so you can switch back with
one tap (the five most recent are kept, counting the one in use; press and hold one to remove it). The app is signed in to one server at a
time: to use another, sign out, open the server screen from the sign-in screen and pick it, then
sign in there. Changing the server signs the device out of the previous one, as described in
[Apps and clients](./self-host-clients.md#connect-mobile-clients).

## What you can do

- Chat with bots and groups, attach photos, files or camera shots, and talk instead of typing.
- Answer questions and [approvals](./approvals.md), and save credentials a bot asks for.
- Open a bot's profile to see its **Computer** and settings, or go to **Routines** to
  [create or edit a routine](./routines.md#on-mobile).
- Take control of a bot's computer, with an on-screen keyboard.
- Call a bot, or answer when a bot calls you. See [Voice and calls](./voice-and-calls.md).
- Connect apps, manage skills, models, voice, approvals, chat apps and your vault from Settings.

The first time you send something, the app asks permission to share it with the AI services your
server uses. Review or withdraw it later in **AI data sharing** in Settings.

On an iPad, an unfolded iPhone Duo or an Android tablet, the chat list stays beside the open chat.

Turn off **Haptics** in Settings if you don't want touch feedback.

## What stays on web and desktop

- [Teach a task](./skills.md#teach-a-task-by-showing-it).
- [Using your own computer](./desktop-app.md) with bots.

## Notifications

Bots notify you when they finish or need input, controlled per bot with
**When it finishes or needs input** in its settings.

On iOS, Live Activities show bots at work on the Lock Screen and in the Dynamic Island.
They are unavailable with the App Store build connected to a self-hosted server; see
[the APNs requirements](./self-host-clients.md#mobile-incoming-calls).

On Android, **Notifications** in Settings also lets you choose which kinds you get, including a live
working status while a bot runs.

## Shortcuts and Siri

On iPhone, Rakazo adds actions to Shortcuts, Siri and the Action button:

- **Message Bot** and **Ask Bot**: send a message. Ask Bot also returns the reply.
- **Record Message**: talk, then pause or press again to send it to the bot whose chat you opened last.
  Progress shows in the Dynamic Island and on the Lock Screen.
- **Open Bot**, **Start Voice Chat** and **Run Routine**.

## Share to a bot

On iOS, open another app's share sheet and choose **Rakazo** to share text, a link, images or files.
Pick a bot to open the chat with the shared content in the draft, then review it before sending.

On Android, share text, images, audio, video, PDFs or files from another app to Rakazo.
Pick a bot to open the chat with the shared content in the draft, then review it before sending.
