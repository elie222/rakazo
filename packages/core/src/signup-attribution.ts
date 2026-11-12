import type { SignupAttribution as Attribution } from "@rakazo/contracts";
import {
  SIGNUP_ATTRIBUTION_COOKIE,
  SIGNUP_SURFACE_HEADER,
  SignupAttribution,
  SignupSurface,
} from "@rakazo/contracts";
import { getDomain } from "tldts";

export function signupAttributionFromCookie(cookie: string): Attribution {
  const encoded = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SIGNUP_ATTRIBUTION_COOKIE}=`))
    ?.slice(SIGNUP_ATTRIBUTION_COOKIE.length + 1);
  if (!encoded || encoded.length > 3000) return {};
  try {
    return SignupAttribution.parse(JSON.parse(decodeURIComponent(encoded)));
  } catch {
    return {};
  }
}

export function signupAttributionFromHeaders(headers?: Headers): Attribution {
  const attribution = signupAttributionFromCookie(headers?.get("cookie") ?? "");
  const surface = SignupSurface.safeParse(headers?.get(SIGNUP_SURFACE_HEADER));
  return { ...attribution, ...(surface.success ? { surface: surface.data } : {}) };
}

/** First acquisition touch survives navigation and the hosted marketing → app handoff. */
export function rememberSignupAttribution(
  browser: { location: { href: string }; document: { cookie: string; referrer: string } },
  surface?: Attribution["surface"],
): void {
  try {
    const { document } = browser;
    const url = new URL(browser.location.href);
    const previous = signupAttributionFromCookie(document.cookie);
    const next = { ...previous, ...(surface ? { surface } : {}) };
    const hasAcquisition = Object.keys(previous).some((key) => key !== "surface");
    if (!hasAcquisition) {
      for (const [field, parameter] of [
        ["utmSource", "utm_source"],
        ["utmMedium", "utm_medium"],
        ["utmCampaign", "utm_campaign"],
        ["utmContent", "utm_content"],
        ["utmTerm", "utm_term"],
      ] as const) {
        const value = SignupAttribution.shape[field].safeParse(url.searchParams.get(parameter));
        if (value.success && value.data) next[field] = value.data;
      }
      if (document.referrer) {
        const referringDomain = new URL(document.referrer).hostname;
        const ownDomain = getDomain(url.hostname) ?? url.hostname;
        if (referringDomain !== ownDomain && !referringDomain.endsWith(`.${ownDomain}`)) {
          const value = SignupAttribution.shape.referringDomain.safeParse(referringDomain);
          if (value.success) next.referringDomain = value.data;
        }
      }
    }
    if (!Object.keys(next).length || JSON.stringify(next) === JSON.stringify(previous)) return;
    const domain = getDomain(url.hostname);
    document.cookie = `${SIGNUP_ATTRIBUTION_COOKIE}=${encodeURIComponent(JSON.stringify(next))}; Path=/; Max-Age=2592000; SameSite=Lax${url.protocol === "https:" ? "; Secure" : ""}${domain ? `; Domain=${domain}` : ""}`;
  } catch {
    // Optional measurement must not prevent navigation or authentication when cookies are blocked.
  }
}
