import type { Me } from "@rakazo/contracts";
import type { Dispatch, SetStateAction } from "react";
import { ComputerUpdateProgress } from "../../components/computers/ComputerUpdateProgress";
import { HostComputerPrompt } from "./host-computer-prompt";
import { TimezonePrompt, withSavedTimezone } from "./timezone-prompt";

/** The shell's one-off prompts: computer updates, host setup and the timezone. */
export function ShellPrompts({
  userId,
  bootstrapMe,
  setBootstrapMe,
  active,
  refreshThread,
}: {
  userId: string | undefined;
  bootstrapMe: Me | null | undefined;
  setBootstrapMe: Dispatch<SetStateAction<Me | null | undefined>>;
  active: { id: string } | undefined;
  refreshThread: (botId: string) => Promise<unknown> | undefined;
}) {
  return (
    <>
      <ComputerUpdateProgress
        onCompleted={() => {
          if (active) void refreshThread(active.id);
        }}
      />
      {bootstrapMe !== undefined ? (
        <HostComputerPrompt initialMe={bootstrapMe ?? undefined} onMeUpdated={setBootstrapMe} />
      ) : null}
      {userId && bootstrapMe ? (
        <TimezonePrompt
          key={userId}
          userId={userId}
          timezone={bootstrapMe.timezone}
          onSaved={(me, adopted) => setBootstrapMe((prev) => withSavedTimezone(prev, me, adopted))}
        />
      ) : null}
    </>
  );
}
