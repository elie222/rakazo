# Routines

A routine is a prompt a bot runs on its own: on a schedule, when something changes, or when another
service calls it.

## Ask for one in chat

The quickest way is to ask:

- "Every weekday at 8am, summarize my inbox."
- "Remind me in 20 minutes to call Dana."
- "Every Monday, check our competitors' pricing pages and tell me what changed."

The bot creates the routine and reports each run back in the same chat.

## Create or edit one yourself

Open the bot's computer with **Agent computer** at the top of the chat. Below the screen is the
bot's **Routines** list. Choose **Create Routine** (the **+**), or click a routine to edit it.

1. **Name** the routine and write the **Instruction**: what it should do each time it runs.
2. Under **When to run**, choose **Add trigger**.
3. Choose **Save**.

Under **Advanced** you can give a routine its own **Model** and **Thinking** level, for example a
cheaper model for a simple daily check.

### Silent routines

For housekeeping, such as tidying a board, updating memory or a page, or sending an email, turn on
**Silent** under **Advanced**. Its scheduled and change-triggered runs, and **Run now**, post
nothing to the chat, mark nothing unread and send no notification when they finish. Each run's
steps and reply, with the files and images it makes, stay in **Run history**: click a run to read
them. The bot keeps a routine's other tools, such as messaging another bot, but can't message or
call you in the chat, or make a video, which arrives in the chat after the run. A silent routine still asks in
the chat when it needs you, and when a run fails it says so there and notifies you. Runs started by
a webhook, Git event, email or message still post in the chat, since they start from a message.
You can also ask the bot for a silent routine.

## Triggers

### On a schedule

Every hour, every day, weekdays, every week, every month, or a custom interval. **Advanced...**
accepts a cron expression. Times use your timezone, set in **Settings → General**.

### When something changes

The bot checks something at a set interval (**Check every**, from 5 minutes to a day) and runs only
when it changed. **What to watch** can be files or folders on the computer, a command's output, or a
tool from a connected app. Turn on **Post "No changes" in chat** if you want a note every time. A
watch can't be combined with a schedule.

### Webhook

Gives you a URL and key. Any service that can send a POST request can start the routine.

### Git event

Gives you a URL to add as a GitHub webhook, so pushes, issues and pull requests can start the
routine.

### Email

Runs when mail arrives at the bot's own address, such as `scout@bots.example.com`. The first
time, pick the part before the @; it stays the bot's for good. Forward or CC mail to it and the
routine runs with that email. Choose who can start it: **Only me**, or **Anyone at** your own
email domain. Mail from anyone else, and mail sent BCC, starts nothing, but the bot keeps every
email in its inbox either way. If mail from your own address can't be verified, the chat says so;
your email provider then needs DKIM signing turned on for your domain. Appears only when your
server [receives email](./self-host-inbound-email.md).

### Slack message

Runs when the bot receives a message in Slack. Needs [Slack connected](./messaging-apps.md).

> [!NOTE]
> Runs started by a webhook or an outside message follow stricter [approval](./approvals.md) rules,
> since outside text could steer what the bot does.

## Test, pause and review

- **Test run** runs a saved routine now.
- Turn off **Active** to pause a routine without deleting it.
- **Run history** shows each past run and its result.
- A running routine shows **Running** in the list, with **Stop**.

## On mobile

The mobile app lists a bot's routines from its profile. Tap **+** to create one. Tapping a routine
shows its instruction, schedule, next run and run history, with a switch to pause it and a button to
test it; tap a silent run to read its reply. **Edit routine** changes its name, instruction,
schedules and **Silent**, or deletes it. Webhook, Git event, Slack
message and change triggers, and a routine's own model, are set up in chat or the web or desktop
app; mobile shows them and keeps them as they are.
