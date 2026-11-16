import { Trans, useLingui } from "@lingui/react/macro";
import type { BotAvatarSet } from "@rakazo/contracts";
import { BOT_NAME_MAX_LENGTH } from "@rakazo/contracts";
import {
  newBotLook,
  newBotLookInput,
  newBotPreviewIdentity,
  ORGANIC_PREVIEW_IDENTITIES,
} from "@rakazo/core";
import {
  BotAvatar,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@rakazo/ui-web";
import { useRef, useState } from "react";
import { useSave } from "../../lib/query";
import type { RpcClient } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { BotLookPicker } from "./avatar-studio-popover";

export interface CreateBotDialogInput {
  name: string;
  color: string;
  /** Reserve the logo preview's persistent seed through creation and retries. */
  id?: string;
  /** The organic family the preview drew; omitted when a studio shape is picked. */
  avatarFamily?: number;
}

/** Mounted only while open; the parent unmounts it from `onCancel` or after `onCreate`. */
export function CreateBotDialog({
  avatarSet,
  onCancel,
  onCreate,
}: {
  /** The account's set: the server gives it to the new bot, so the preview draws it too. */
  avatarSet: BotAvatarSet;
  onCancel: () => void;
  onCreate: (input: CreateBotDialogInput, client: RpcClient) => Promise<void>;
}) {
  const { t } = useLingui();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [look, setLook] = useState(newBotLook);
  const identity = newBotPreviewIdentity(avatarSet, look);
  // Creating the bot closes this dialog, so a success keeps it held.
  const save = useSave({ save: onCreate, closesScreen: true });
  const submitting = save.pending;
  const error = save.error ? errorText(save.error, t`Could not create bot`) : null;
  const trimmed = name.trim();

  function create() {
    if (!trimmed || submitting) return;
    save.run({ name: trimmed, ...newBotLookInput(avatarSet, look) });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onCancel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        initialFocus={nameRef}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
        data-testid="create-bot-dialog"
      >
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-center">
              <Trans>New bot</Trans>
            </DialogTitle>
          </DialogHeader>
          <div className="flex justify-center py-2">
            <BotAvatar color={look.color} identity={identity} size={96} avatarSet={avatarSet} />
          </div>
          <Input
            ref={nameRef}
            aria-label={t`Name`}
            placeholder={t`Name your Bot`}
            value={name}
            maxLength={BOT_NAME_MAX_LENGTH}
            onChange={(event) => setName(event.target.value)}
            className="text-center"
          />
          {error ? (
            <p
              role="alert"
              data-testid="create-bot-error"
              className="text-body-sm text-destructive"
            >
              {error}
            </p>
          ) : null}
          <BotLookPicker
            value={look.color}
            identity={identity}
            organicIdentities={ORGANIC_PREVIEW_IDENTITIES}
            avatarSet={avatarSet}
            onChange={(color, picked) => {
              setLook((current) => ({ ...current, color, identity: picked ?? current.identity }));
            }}
          />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={onCancel}>
              <Trans>Cancel</Trans>
            </Button>
            <Button type="submit" disabled={!trimmed || submitting}>
              <Trans>Create</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
