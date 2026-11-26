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
const login = z.object({
  id: Id,
  origin: z.string(),
  name: loginName,
  botIds,
  hasSession: z.boolean(),
});
const controlName = z.string().trim().min(1).max(300);
export const organizationVaultRpc = {
  settings: oc.output(
    z.object({
      signInAvailable: z.boolean(),
      agents: z.array(z.object({ id: Id, name: z.string() })),
      logins: z.array(login),
    }),
  ),
  signIn: oc
    .input(
      loginId
        .extend({
          url: z.string().trim().min(1).max(2048),
          usernameLabel: controlName,
          username: z.string().min(1).max(4096),
          passwordLabel: controlName,
          password: z.string().min(1).max(4096),
          submitLabel: controlName,
          successHeading: controlName,
        })
        .strict(),
    )
    .output(login),
  revokeSession: oc.input(loginId).output(login),
  list: oc.output(z.array(login)),
  create: oc
    .input(z.object({ origin: OrganizationLoginOrigin, name: loginName, botIds }))
    .output(login),
  setAgents: oc.input(loginId.extend({ botIds })).output(login),
  remove: oc.input(loginId).output(z.object({ ok: z.literal(true) })),
};
