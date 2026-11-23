import { z } from "zod";

/** The partner program's click that brought a visitor, kept apart from the analytics attribution. */
export const PARTNER_CLICK_COOKIE = "rakazo_partner_click";
export const PartnerClickId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/);
