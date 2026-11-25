# Pages

A bot can build a page for anything that reads better as a page than as a chat message, such as a
dashboard, a status board or a report. Ask for one in chat:

- "Make me a page that tracks our open deals."
- "Turn this research into a page I can share with the team."

The page appears as a card in the chat. Open it to see it full screen, with the chat below so you
can ask for changes. The bot edits the same page rather than making a new one, so a
[routine](./routines.md) can keep it up to date.

Pages can show pictures: images the bot generated, files from the chat or its computer, and
images from the web. The bot fetches a web image only from a site it could already fetch from in
that chat, so ask it to open a new site first. Each picture is redrawn as a still WebP up to 1600
pixels wide or tall and kept with the page's files, like a chat file: under `DATA_DIR`, or in
[object storage](./self-host-storage.md) when one is configured. It is shown wherever the page
is, including shared links, review and PDF, and is removed with the page. A page holds up to 24
pictures.

Ticks and notes you add on a page stay there for you, on every device. Each person a page is
shared with keeps their own, and the bot can read yours when you ask about them. On a page opened
from a link, they last until it reloads.

## Find your pages

On web and desktop, select the bot or group name at the top of the chat to open its panel.

- In a bot chat, **Pages** appears once the bot has built a page. If the preview doesn't show all
  the pages, select its **Pages** heading to see the full list.
- In a group chat, look for **Pages** in **Group settings**.

On mobile, tap the bot or group name at the top of the chat. Select **Pages** in **Profile**
for a bot chat or in **Group settings** for a group chat.

Use the menu beside a page to rename, pin or delete it.

## Share a page

Pages are private at first. To share one, choose **Share**, set it to **Anyone with the link** and
**Copy link**. Anyone with the link can view the page without signing in. Set it back to
**Only you** to turn the link off.

On web and desktop, **Download PDF** saves a copy through your browser's print dialog.

### Share with specific people

Choose **Specific people** and enter each person's verified Rakazo account email. Send the
review link, or have them open **Pages shared with you** from their account menu. They can
read the page from the revision you shared onward and join its review. Remove a person from
**Share** to revoke their access. Switching away from **Specific people** removes those grants. If someone verifies their
account after you add their address, add it again to give them access. If their account was deleted,
adding their new verified account starts access at the current revision.

### Review a page

Open **Comments**, choose a section and post your comment. Each comment stays attached to the
revision you read. Open its revision to see the original section. The page owner or the person
who posted the comment can resolve or reopen it.

Use **Ask bot to revise** on an open comment on the latest revision to request a draft. The
bot receives the page and that comment. The page owner can preview and publish the draft as
a new revision. Posting a comment alone leaves the bot idle.
