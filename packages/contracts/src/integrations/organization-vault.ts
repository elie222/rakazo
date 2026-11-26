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
const signInStep = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("fill"),
    role: z.literal("textbox"),
    name: controlName,
    text: z.string().min(1).max(4096),
  }),
  z.object({ kind: z.literal("click"), role: z.literal("button"), name: controlName }),
  z.object({ kind: z.literal("wait"), role: z.literal("heading"), name: controlName }),
]);

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
      loginId.extend({
        url: z.string().trim().max(2048),
        steps: z.array(signInStep).min(3).max(10),
      }),
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
