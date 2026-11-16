import { useCallback, useEffect, useRef } from "react";
import { discardPrimedBootstrap, primeSpaceBootstrap } from "../../lib/bootstrap";
import { initialBootstrapTarget } from "../../lib/bootstrap-target";
import { getSnapshot as getCallSnapshot, isLeavingSession } from "../../lib/call-session";
import { leaveOrganization } from "../../lib/organizations";
import { queryClient, spaceSeedKey } from "../../lib/query";
import { selectedSpaceId, selectSpace } from "../../lib/rpc";
import { remountShellForSpace, spaceSwitchDecision } from "../../lib/space-switch";
import { speaker } from "../../lib/tts";
import { readShellOverlay, searchString, withShellOverlay } from "../shell-overlay";
import type { useShellNavigation } from "./use-shell-navigation";

/**
 * Opens a chat in any of the user's spaces, including another organization's; another space loads
 * first, then the shell remounts into it.
 */
export function useOpenSpaceChat({
  bootstrapSpaceId,
  userId,
  navigate,
  navigationRevision,
  overlayRevision,
  closeMobileSidebar,
  beginSpaceSwitch,
}: {
  bootstrapSpaceId: string | undefined;
  userId: string | undefined;
  navigate: ReturnType<typeof useShellNavigation>["navigate"];
  navigationRevision: ReturnType<typeof useShellNavigation>["navigationRevision"];
  overlayRevision: ReturnType<typeof useShellNavigation>["overlayRevision"];
  closeMobileSidebar: () => void;
  /** Keeps the route from being moved under a switch while `live`; the returned function ends that. */
  beginSpaceSwitch: (live: () => boolean) => (leftSpace: boolean) => void;
}) {
  const spaceSwitchRequest = useRef(0);
  useEffect(() => {
    const onPopState = () => {
      spaceSwitchRequest.current += 1;
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      // A switch still loading when this shell goes away (another page, or a
      // newer switch) must not pull the user back to its space afterwards.
      spaceSwitchRequest.current += 1;
      window.removeEventListener("popstate", onPopState);
    };
  }, []);
  return useCallback(
    (spaceId: string, path: string) => {
      closeMobileSidebar();
      const request = ++spaceSwitchRequest.current;
      const startedNavigation = navigationRevision.current;
      const startedOverlay = overlayRevision.current;
      const startedIndex = window.history.state?.idx;
      const previousEffective = selectedSpaceId() ?? bootstrapSpaceId;
      // Persist the active space (including primary) so voice/RPC headers match the chat.
      if (previousEffective === spaceId) {
        if (selectSpace(spaceId)) navigate(path);
        return;
      }
      // Signing out clears the selected space; a switch that finishes afterwards must not select one.
      const live = () => request === spaceSwitchRequest.current && !isLeavingSession();
      const reload = async () => {
        await leaveOrganization(userId ?? null, previousEffective, spaceId);
        if (!live() || !selectSpace(spaceId)) return false;
        window.location.assign(destination());
        return true;
      };
      const destination = () =>
        overlayRevision.current === startedOverlay
          ? path
          : `${path}${searchString(withShellOverlay(new URLSearchParams(), readShellOverlay(new URLSearchParams(window.location.search))))}`;
      // Another space is an auth boundary: its bootstrap is loaded first, under that
      // space's header, then the shell remounts so none of this space's state survives.
      // A call in progress, or a page outside the shell, still reloads.
      const target = initialBootstrapTarget(path, false);
      if (!target || getCallSnapshot()) {
        void reload();
        return;
      }
      const startedAt = window.location.pathname;
      const decision = () =>
        spaceSwitchDecision(
          live() &&
            startedNavigation === navigationRevision.current &&
            startedIndex === window.history.state?.idx,
          startedAt,
          window.location.pathname,
          Boolean(getCallSnapshot()),
        );
      const current = () => decision() !== "abandon";
      // A space visited before opens at once with what it showed then, refreshing behind it.
      const cached = queryClient.getQueryData(spaceSeedKey(userId ?? null, spaceId));
      const primed = primeSpaceBootstrap(spaceId, target.botId, cached);
      const commit = () => {
        const action = decision();
        if (action !== "commit") return action;
        if (!selectSpace(spaceId)) return "abandon";
        void leaveOrganization(userId ?? null, previousEffective, spaceId);
        // Playback belongs to the conversation being left.
        speaker.stop();
        navigate(destination());
        return "commit";
      };
      /** What `commit` decided once the shell could remount; a commit that threw abandoned. */
      const remount = () => {
        let decided!: (action: ReturnType<typeof commit>) => void;
        const outcome = new Promise<ReturnType<typeof commit>>((resolve) => {
          decided = resolve;
        });
        remountShellForSpace(() => {
          let action: ReturnType<typeof commit> = "abandon";
          try {
            action = commit();
            return action === "commit";
          } finally {
            decided(action);
          }
        });
        return outcome;
      };
      /** Whether the app left for the other space, by remounting the shell or reloading the page. */
      const leave = async () => {
        if (!cached) {
          const loaded = await primed.then(
            () => true,
            () => false,
          );
          // A call started while the bootstrap loaded belongs to this space.
          if (!current() || !loaded || getCallSnapshot()) {
            discardPrimedBootstrap(primed);
            return current() && reload();
          }
        }
        const action = await remount();
        if (action === "commit") return true;
        discardPrimedBootstrap(primed);
        if (action !== "reload") return false;
        // Leave the view-transition update before starting a full navigation.
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        return current() && reload();
      };
      const endSwitch = beginSpaceSwitch(current);
      void (async () => {
        let leftSpace = false;
        try {
          leftSpace = await leave();
        } finally {
          endSwitch(leftSpace);
        }
      })();
    },
    [beginSpaceSwitch, bootstrapSpaceId, navigate, navigationRevision, overlayRevision, userId],
  );
}
