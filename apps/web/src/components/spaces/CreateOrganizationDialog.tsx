import { Trans } from "@lingui/react/macro";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  Input,
} from "@rakazo/ui-web";
import { useId, useState } from "react";
import { useQueryUserId, useSave } from "../../lib/query/query";
import { errorText } from "../../lib/query/user-error";
import { openOrganizationSpace, organizationsQuery } from "../../lib/spaces/organizations";

/** Creates an organization and moves into it, where onboarding sets up its first bot. */
export function CreateOrganizationDialog({
  open,
  onOpenChange,
  openSpaceChat,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  openSpaceChat?: (spaceId: string, path: string) => void;
}) {
  const userId = useQueryUserId();
  const nameId = useId();
  const [name, setName] = useState("");
  const create = useSave({
    save: (trimmed: string, rpc) => rpc.organizations.create({ name: trimmed }),
    stale: [organizationsQuery(userId).queryKey],
    closesScreen: true,
    onSaved: async (created) => {
      // The new organization is listed even if this device cannot switch into it.
      if (
        !(await openOrganizationSpace(userId, created.defaultSpaceId, "/onboarding", openSpaceChat))
      )
        window.location.assign("/");
    },
  });
  const saving = create.pending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        onOpenChange(next);
        if (!next) {
          setName("");
          create.reset();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Create organization</Trans>
          </DialogTitle>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (trimmed) create.run(trimmed);
          }}
        >
          <Field>
            <FieldLabel htmlFor={nameId}>
              <Trans>Name</Trans>
            </FieldLabel>
            <Input
              id={nameId}
              maxLength={60}
              value={name}
              disabled={saving}
              onChange={(event) => {
                setName(event.target.value);
                create.reset();
              }}
              autoFocus
            />
            <FieldError>{create.error ? errorText(create.error) : null}</FieldError>
          </Field>
          <DialogFooter>
            <Button type="submit" disabled={saving || !name.trim()}>
              <Trans>Create</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
