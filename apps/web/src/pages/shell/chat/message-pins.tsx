import { Trans, useLingui } from "@lingui/react/macro";
import type { PinnedMessage } from "@rakazo/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  toast,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Pin } from "lucide-react";
import type { ReactNode } from "react";
import { createContext, useContext, useMemo, useRef } from "react";
import type { ChatTarget } from "../../../lib/query/query";
import { useSave, useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";

type PinInput = { messageId: string; pinned: boolean };

const MessagePinsContext = createContext<{
  pins: readonly PinnedMessage[];
  ids: ReadonlySet<string>;
  setPin?: (input: PinInput) => void;
  onJump?: (messageId: string) => void;
} | null>(null);

export function MessagePinsProvider({
  target,
  onJump,
  children,
}: {
  target?: ChatTarget;
  onJump?: (messageId: string) => void;
  children: ReactNode;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const read = queries.threads.pins.queryOptions({
    input: target ?? {},
    enabled: Boolean(target),
    refetchOnWindowFocus: "always",
  });
  const { data } = useQuery(read);
  const save = useSave<PinInput>({
    save: (input, rpc) => rpc.threads.setPin({ ...target, ...input }),
    stale: [read.queryKey],
    onFailed: (error) => toast.error(errorText(error, t`Could not save`)),
  });
  const run = useRef(save.run);
  run.current = save.run;
  const value = useMemo(
    () => ({
      pins: data ?? [],
      ids: new Set(data?.map((pin) => pin.messageId)),
      setPin: data && !save.pending ? (input: PinInput) => run.current(input) : undefined,
      onJump,
    }),
    [data, save.pending, onJump],
  );
  return <MessagePinsContext value={value}>{children}</MessagePinsContext>;
}

export function useMessagePins() {
  return useContext(MessagePinsContext);
}

export function MessagePinsMenu() {
  const { t } = useLingui();
  const model = useMessagePins();
  if (!model?.pins.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t`Pinned messages`}
        render={<Button variant="floating" size="icon-lg" className="app-no-drag" />}
      >
        <Pin strokeWidth={1.75} className="size-4.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-72 overflow-y-auto">
        {model.pins.map((pin) => (
          <DropdownMenuItem key={pin.messageId} onClick={() => model.onJump?.(pin.messageId)}>
            <span className="truncate" dir="auto">
              {pin.text || (pin.image ? <Trans>Image</Trans> : <Trans>Message</Trans>)}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
