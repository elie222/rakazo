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

Configure the status webhook to use `/api/meetings/events` on your public API origin. Subscribe to bot lifecycle events, `recording.done`, `recording.failed`, `transcript.done`, and `transcript.failed`. The operator's workspace incurs per-minute capture and transcription costs. This deployment admits up to 20 manual meetings per Space per rolling day. A meeting can record for up to two hours.

The server configures audio-only capture and 24-hour provider retention. Once Rakazo imports the transcript it requests removal of the provider copy of the recording. Rakazo stores the transcript under the Space's content-encryption policy.

## Test without joining an external meeting

Set `MEETING_PROVIDER=emulator` in a development process. The emulator immediately admits the bot and returns a synthetic transcript after you select **Leave meeting**.

Run the web flow through the local emulator with:

```sh
MEETING_PROVIDER=emulator pnpm test:e2e -- --spec=meeting-transcript.spec.ts
```
