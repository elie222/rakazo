import type { BotAvatarSet } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nBootstrap } from "../../src/components/I18nBootstrap";
import { AvatarStudioPopover } from "../../src/pages/shell/avatar-studio-popover";
import type { CreateBotDialogInput } from "../../src/pages/shell/create-bot-dialog";
import { CreateBotDialog } from "../../src/pages/shell/create-bot-dialog";
import "../../src/styles.css";

type Sample = { id: string; name: string; color: string; avatarSet?: BotAvatarSet };
const samples: Sample[] = [
  { id: "legacy", name: "Existing bot", color: "#10B981" },
  { id: "original-shape", name: "Original shape", color: "#8B5CF6::shape_2", avatarSet: "organic" },
  { id: "logo", name: "Rakazo bot", color: "#3B82F6", avatarSet: "rakazo" },
  {
    id: "photo",
    name: "Uploaded image",
    color:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  },
];
const storageKey = "avatar-set-settings-fixture";
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";

function Study() {
  const [bots, setBots] = useState<Sample[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || "null") || samples;
    } catch {
      return samples;
    }
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreateBotDialogInput | null>(null);
  return (
    <main className="mx-auto max-w-3xl p-8 text-foreground">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-heading2 font-semibold">Bot icon sets</h1>
        <Button onClick={() => setCreateOpen(true)}>New bot</Button>
      </header>
      <div className="grid grid-cols-2 gap-6">
        {bots.map((bot) => (
          <article
            className="rounded-2xl border border-border bg-card p-6 text-center"
            key={bot.id}
            data-testid={`${bot.id}-sample`}
          >
            <AvatarStudioPopover
              value={bot.color}
              avatarSet={bot.avatarSet}
              identity={bot.id}
              onChange={(color, avatarSet) => {
                const next = bots.map((current) =>
                  current.id === bot.id
                    ? { ...current, color, ...(avatarSet !== undefined ? { avatarSet } : {}) }
                    : current,
                );
                localStorage.setItem(storageKey, JSON.stringify(next));
                setBots(next);
              }}
            />
            <h2 className="mt-3 text-body1 font-medium">{bot.name}</h2>
          </article>
        ))}
      </div>
      {created && (
        <output className="mt-6 block text-label text-muted-foreground" data-testid="created-bot">
          {JSON.stringify(created)}
        </output>
      )}
      {createOpen && (
        <CreateBotDialog
          onCancel={() => setCreateOpen(false)}
          onCreate={async (input) => {
            setCreated(input);
            setCreateOpen(false);
          }}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <I18nBootstrap>
    <Study />
  </I18nBootstrap>,
);
