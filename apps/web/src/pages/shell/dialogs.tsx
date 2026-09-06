import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@rakazo/ui-web";
import { Lock } from "lucide-react";
import { useId, useState } from "react";

/** Each dialog is mounted only while open, so `open` is always true and the
 * parent unmounts it from `onCancel`. Escape and backdrop presses are ignored
 * while a request is in flight. */
function closeUnlessBusy(busy: boolean, onCancel: () => void) {
  return (open: boolean) => {
    if (!open && !busy) onCancel();
  };
}

export function NewSpaceDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: (name: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    void onConfirm(trimmed).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : t`Could not create space`);
      setSaving(false);
    });
  };

  return (
    <Dialog open onOpenChange={closeUnlessBusy(saving, onCancel)}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <Lock
              size={17}
              strokeWidth={1.8}
              className="text-muted-foreground"
              aria-hidden="true"
            />
            <Trans>New space</Trans>
          </DialogTitle>
        </DialogHeader>
        <label htmlFor={nameId} className="block text-[13.5px] text-foreground/75">
          <Trans>Name</Trans>
          <Input
            id={nameId}
            maxLength={60}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") create();
            }}
            placeholder={t`Customer support`}
            className="mt-2"
          />
        </label>
        {error ? <p className="text-[13.5px] text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
          <Button disabled={saving || !name.trim()} onClick={create}>
            {saving ? <Trans>Creating…</Trans> : <Trans>Create space</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function NewBotSectionDialog({
  bot,
  onCancel,
  onConfirm,
}: {
  bot: Pick<Bot, "name">;
  onCancel: () => void;
  onConfirm: (name: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open onOpenChange={closeUnlessBusy(saving, onCancel)}>
      <DialogContent showCloseButton={false}>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (!trimmed || saving) return;
            setSaving(true);
            setError(null);
            void onConfirm(trimmed).catch((err: unknown) => {
              setError(err instanceof Error ? err.message : t`Could not create section`);
              setSaving(false);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>New section</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>Create a section and move {bot.name} into it.</Trans>
            </DialogDescription>
          </DialogHeader>
          <label htmlFor={nameId} className="block text-[13.5px] text-foreground/75">
            <Trans>Name</Trans>
            <Input
              id={nameId}
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-2"
            />
          </label>
          {error ? <p className="text-[13.5px] text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              {saving ? <Trans>Creating…</Trans> : <Trans>Create</Trans>}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ClearConversationDialog({
  bot,
  onCancel,
  onConfirm,
}: {
  bot: Pick<Bot, "name">;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <AlertDialog open onOpenChange={closeUnlessBusy(clearing, onCancel)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <Trans>Clear {bot.name}’s conversation?</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>
              This permanently removes every message and stops current work. The chat remains
              available.
            </Trans>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="text-[13.5px] text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={clearing}>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={clearing}
            onClick={() => {
              setClearing(true);
              setError(null);
              void onConfirm().catch((err: unknown) => {
                setError(err instanceof Error ? err.message : t`Could not clear conversation`);
                setClearing(false);
              });
            }}
          >
            {clearing ? <Trans>Clearing…</Trans> : <Trans>Clear</Trans>}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DeleteBotDialog({
  bot,
  onCancel,
  onConfirm,
}: {
  bot: Bot;
  onCancel: () => void;
  onConfirm: (deleteMemories: boolean) => Promise<void>;
}) {
  const { t } = useLingui();
  const [deleting, setDeleting] = useState(false);
  const [deleteMemories, setDeleteMemories] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <AlertDialog open onOpenChange={closeUnlessBusy(deleting, onCancel)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <Trans>Delete {bot.name}?</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>
              Its conversation, files, and routines will be permanently deleted. Bots it created
              stay in your list.
            </Trans>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-[13.5px] text-foreground/75">
            <Trans>What about its memories?</Trans>
          </legend>
          <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-3">
            <input
              type="radio"
              name="delete-memory"
              checked={!deleteMemories}
              onChange={() => setDeleteMemories(false)}
            />
            <span>
              <span className="block text-[14px] text-foreground">
                <Trans>Keep memories</Trans>
              </span>
              <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
                <Trans>Move them to your shared memory.</Trans>
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer gap-3 rounded-lg border border-border p-3">
            <input
              type="radio"
              name="delete-memory"
              checked={deleteMemories}
              onChange={() => setDeleteMemories(true)}
            />
            <span>
              <span className="block text-[14px] text-foreground">
                <Trans>Delete memories too</Trans>
              </span>
              <span className="mt-0.5 block text-[12.5px] text-muted-foreground">
                <Trans>This cannot be undone.</Trans>
              </span>
            </span>
          </label>
        </fieldset>
        {error ? <p className="text-[13.5px] text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting}
            onClick={() => {
              setDeleting(true);
              setError(null);
              void onConfirm(deleteMemories).catch((err: unknown) => {
                setError(err instanceof Error ? err.message : t`Could not delete bot`);
                setDeleting(false);
              });
            }}
          >
            {deleting ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DeleteItemDialog({
  item,
  noun,
  onCancel,
  onConfirm,
}: {
  item: { name: string };
  noun: "group" | "routine";
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <AlertDialog open onOpenChange={closeUnlessBusy(deleting, onCancel)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <Trans>Delete {item.name}?</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>This cannot be undone.</Trans>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="text-[13.5px] text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting}
            onClick={() => {
              setDeleting(true);
              setError(null);
              void onConfirm().catch((err: unknown) => {
                setError(
                  err instanceof Error
                    ? err.message
                    : noun === "group"
                      ? t`Could not delete group`
                      : t`Could not delete routine`,
                );
                setDeleting(false);
              });
            }}
          >
            {deleting ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
