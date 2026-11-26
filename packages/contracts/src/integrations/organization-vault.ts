import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";
import { otherSiteOrigin } from "./vault-items.js";

export const OrganizationLoginOrigin = z
  .string()
  .trim()
  .max(2048)
  .refine((site) => URL.canParse(site) && new URL(site).protocol === "https:", {
    message: "Enter an HTTPS site",
  })
  .transform((site, ctx) => {
    const origin = otherSiteOrigin(site);
    if (origin) return origin;
    ctx.addIssue({ code: "custom", message: "Enter an HTTPS site without credentials" });
    return z.NEVER;
  });

const loginName = z.string().trim().min(1).max(100);
const botIds = z.array(Id).max(100);
const loginId = z.object({ loginId: Id });
const login = z.object({ id: Id, origin: z.string(), name: loginName, botIds });

export const organizationVaultRpc = {
  list: oc.output(z.array(login)),
  create: oc
    .input(z.object({ origin: OrganizationLoginOrigin, name: loginName, botIds }))
    .output(login),
  setAgents: oc.input(loginId.extend({ botIds })).output(login),
  remove: oc.input(loginId).output(z.object({ ok: z.literal(true) })),
};
