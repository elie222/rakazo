import { createKeyedListeners } from "@rakazo/core";

const offers = createKeyedListeners<string>();

/** Text a card in a chat hands to that chat's composer; the person still sends it. */
export const offerComposerText = offers.emit;
export const subscribeComposerOffer = offers.subscribe;
