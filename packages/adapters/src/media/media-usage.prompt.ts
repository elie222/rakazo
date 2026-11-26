/** Tool errors a bot reads when hosted media is refused, so it can tell the user why. */
export const MEDIA_REFUSALS = {
  unavailable: "Media generation is unavailable.",
  trial: "Image and video generation is unavailable during a trial. It starts with the paid plan.",
  noPlan: "Image and video generation needs a paid plan. The owner can subscribe in Billing.",
  balance: (kind: "image" | "video") =>
    `Not enough media balance left this month for this ${kind}.`,
};
