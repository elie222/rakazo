import type { MessageBlock, PlacesCard } from "@rakazo/contracts";
import { formatDistance } from "@rakazo/core";
import type { RunContext } from "./run-context.js";
import { publishMessage } from "./run-messages.js";
import type { ToolCall, ToolHandlers } from "./run-tool-gate.js";
import { argumentGiven } from "./update-bot-patch.js";

/** What the bot reads back: enough to answer in a sentence while the card carries the detail. */
function summary(card: PlacesCard) {
  return {
    query: card.query,
    count: card.places.length,
    places: card.places.slice(0, 10).map((place) => ({
      name: place.name,
      ...(place.category ? { category: place.category } : {}),
      ...(place.address ? { address: place.address } : {}),
      ...(place.distanceM !== undefined
        ? { distance: formatDistance(place.distanceM, false, "en") }
        : {}),
      ...(place.hours ? { openingHours: place.hours } : {}),
    })),
  };
}

function numberArg(value: unknown): number | undefined {
  if (!argumentGiven(value)) return undefined;
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : Number.NaN;
}

async function placesSearch(ctx: RunContext, call: ToolCall) {
  const { args } = call;
  const query = argumentGiven(args.query) ? String(args.query).slice(0, 200) : "";
  const near = argumentGiven(args.near) ? String(args.near).slice(0, 200) : undefined;
  const latitude = numberArg(args.latitude);
  const longitude = numberArg(args.longitude);
  const limit = numberArg(args.limit);
  let card: PlacesCard;
  try {
    card = await ctx.providers.places.search(
      { query, near, latitude, longitude, limit, signal: ctx.context.signal },
      ctx.context,
    );
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const block: MessageBlock = { kind: "places", card };
  try {
    await publishMessage(ctx.deps, ctx.run, "bot", [block]);
  } catch {
    // The card is a courtesy; the bot can still answer from the list below.
    return { ...summary(card), note: "The places card could not be shown; answer in words." };
  }
  return {
    ...summary(card),
    note: "A places card with a map and the list is now shown in the chat. Reply in one or two short sentences and do not repeat the whole list.",
  };
}

export const placesTools: ToolHandlers = {
  async places_search(ctx, call) {
    return call.finish(await placesSearch(ctx, call));
  },
};
