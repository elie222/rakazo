# Meeting bots

A meeting bot can join a Zoom or Google Meet link and bring back a speaker-labeled transcript. Open **Meetings** in the bot chat and enter the attendee link. Use a meeting where you're allowed to capture audio and create a transcript. Admit the bot from the waiting room when prompted and grant the meeting platform's capture permission.

The transcript belongs to the member who started the session. They can open it from **Meetings**, ask the bot a question about it, or delete it. Ask uses the bot's configured model connection and sends the transcript and question to that model. Meetings are available in web, desktop and mobile.

## Configure a deployment

Set the same meeting-provider configuration on the API and worker.

| Setting                     | Value                                                                            |
| --------------------------- | -------------------------------------------------------------------------------- |
| `MEETING_PROVIDER`          | Use `recall` for Recall.ai. Leave empty to disable new joins.                    |
| `MEETING_API_KEY`           | API credential from the provider workspace.                                      |
| `MEETING_REGION`            | Workspace's region.                                                              |
| `MEETING_WEBHOOK_SECRET`    | Signing secret for the workspace's status webhooks.                              |
| `MEETING_WEBHOOK_SIGNATURE` | `webhook` by default. Set `svix` for older workspaces that use endpoint secrets. |
| `MEETING_SPACE_IDS`         | Comma-separated list of Spaces authorized to send bots.                          |

Configure the status webhook to use `/api/meetings/events` on your public API origin. Subscribe to bot lifecycle events, `recording.done`, `recording.failed`, `transcript.done`, and `transcript.failed`. The operator's workspace incurs per-minute capture and transcription costs. Each Space can use or reserve up to 20 meetings per UTC day. A meeting can record for up to two hours.

The server configures audio-only capture and 24-hour provider retention. Once Rakazo imports the transcript it requests removal of the provider copy of the recording. Rakazo stores the transcript under the Space's content-encryption policy.

## Test without joining an external meeting

Set `MEETING_PROVIDER=emulator` in a development process. The emulator immediately admits the bot and returns a synthetic transcript after you select **Leave meeting**.

Run the web flow through the local emulator with:

```sh
MEETING_PROVIDER=emulator pnpm test:e2e -- --spec=meeting-transcript.spec.ts
```

## Add the branded camera and live voice

Set `MEETING_PUBLIC_ORIGIN` to the public HTTPS origin serving the API on both the API and worker. The meeting bot displays the Rakazo mark and its name on camera. Generate a dedicated `MEETING_SIGNING_KEY` with `openssl rand -hex 32` and set it to the same value on the API and worker. It signs access to the camera page. The meeting provider needs access to `/api/meetings/media` and its assets on that origin.

Enable `MEETING_LIVE_VOICE=true` on the API and worker to let the bot listen and reply when addressed. Voice-enabled bots tell participants in meeting chat that they process speech live and can reply aloud. Configure server-side speech recognition, speech synthesis, and a model for the bot. Live voice uses those connections and their usage limits. The bot receives recent meeting speech as context for replies. The camera page carries that context while it is connected and discards it when it reloads. The post-meeting transcript is imported independently and includes the bot's spoken replies where the meeting provider can attribute them.

## Schedule calendar meetings

On desktop, calendar sign-in opens the system browser and returns to Rakazo. Desktop sign-in requires a public HTTPS web origin.

Set `MEETING_CALENDAR_CLIENT_ID` and `MEETING_CALENDAR_CLIENT_SECRET` on the API and worker to enable calendar scheduling. Both also need the same dedicated `MEETING_SIGNING_KEY` even if the branded camera is disabled. Create a Google OAuth web application for the deployment, enable the Google Calendar API, and register `/api/meetings/calendar/oauth/callback` on the web origin as its redirect URI. Request the read-only calendar-events and email scopes. The meeting provider receives the OAuth refresh token to keep the primary calendar in sync. Rakazo stores the provider's connection ID and your event selections. See the [Google Calendar setup guide](https://docs.recall.ai/docs/calendar-v2-google-calendar).

Send `calendar.update` and `calendar.sync_events` webhooks to `/api/meetings/calendar/webhook` on the public API origin. Use the workspace signing secret. If your workspace uses legacy per-endpoint Svix secrets, set `MEETING_CALENDAR_WEBHOOK_SECRET` to the calendar endpoint's signing secret.

In a bot's **Meetings** view, open **Auto-join**, connect Google Calendar, and choose a single meeting or its recurring series. **Skip this meeting** overrides a series for that occurrence. The **Scheduled** label confirms the provider has reserved a bot. Guest admission and capture permissions still apply. Rakazo reserves meetings within the next 14 days and extends a recurring series as that window moves. Each Space can schedule up to 20 meetings for the same UTC day. Linked calendars with the same selected bot share one scheduled participant per occurrence. The final transcript is available to the member who owns that shared session. If they withdraw before the bot starts joining, Rakazo can pass the reservation to an active member who still has that occurrence booked.

To exercise connection and scheduling with the local emulator, run:

```sh
MEETING_PROVIDER=emulator pnpm test:e2e -- --spec=meeting-calendar.spec.ts
```
