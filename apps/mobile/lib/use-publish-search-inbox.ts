import { useEffect } from "react";
import type { InboxSpace } from "./inbox-spaces";
import { setSearchInbox } from "./search-inbox";

/** Shares the inbox roster with search once a saved or live inbox has supplied the account. */
export function usePublishSearchInbox(inboxSpaces: readonly InboxSpace[], loaded: boolean) {
  useEffect(() => {
    // A remounted session has no roster until its saved or live inbox arrives.
    if (loaded) setSearchInbox(inboxSpaces);
  }, [inboxSpaces, loaded]);
}
