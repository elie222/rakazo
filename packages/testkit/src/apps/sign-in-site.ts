import { randomInt } from "node:crypto";
import type {
  BrowserActRequest,
  BrowserActResult,
  BrowserNavigateRequest,
  BrowserNavigateResult,
  BrowserProvider,
  BrowserSnapshotNode,
  BrowserSnapshotResult,
} from "@rakazo/adapter-kit";

export type SignInSiteOptions = {
  /** The site's HTTPS origin, such as https://app.ledgerly.example. */
  origin: string;
  name: string;
  /** What the signed-in dashboard shows, so a reply can be checked against it. */
  dashboard: string;
  /** The site signs in with this email and password instead of emailing a code. */
  login?: { email: string; password: string; refusal?: string };
};

export type SignInMail = { from: string; fromName: string; subject: string; text: string };

export type SignInSiteState = {
  emailsEntered: string[];
  codesSentTo: string[];
  codesTyped: string[];
  signedIn: boolean;
};

type Page = { title: string; text: string[]; elements: BrowserSnapshotNode[] };

/**
 * A website that signs in with a code it emails. Clicking "Email me a code" mails a fresh code to
 * the address typed, through `deliver`, which puts it in whichever inbox owns that address.
 */
export class SignInSite implements BrowserProvider {
  readonly state: SignInSiteState = {
    emailsEntered: [],
    codesSentTo: [],
    codesTyped: [],
    signedIn: false,
  };
  deliver: (to: string, mail: SignInMail) => Promise<void> = async () => {};
  private readonly options: SignInSiteOptions;
  private readonly host: string;
  private step: "email" | "code" = "email";
  private email = "";
  private code = "";
  private typed = "";
  private password = "";
  private error = "";

  constructor(options: SignInSiteOptions) {
    this.options = options;
    this.host = new URL(options.origin).host;
  }

  describe() {
    return {
      id: "sign-in-site",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { page: true, refs: true, keyless: true },
    };
  }

  async navigate(
    _computer: unknown,
    request: BrowserNavigateRequest,
  ): Promise<BrowserNavigateResult> {
    let url: URL;
    try {
      url = new URL(request.url.trim());
    } catch {
      return { url: request.url, title: "", error: "Invalid URL" };
    }
    if (url.host !== this.host)
      return { url: url.href, title: "", error: `${url.host} could not be reached` };
    return this.snapshot();
  }

  async snapshot(): Promise<BrowserSnapshotResult> {
    const page = this.page();
    const lines = [
      ...page.text.map((text) => `- text ${JSON.stringify(text)}`),
      ...page.elements.map(
        (element) =>
          `- ${element.role} ${JSON.stringify(element.name)} [${element.ref}]${
            element.value !== undefined ? ` value=${JSON.stringify(element.value)}` : ""
          }`,
      ),
    ];
    return { url: this.url(), title: page.title, tree: lines.join("\n"), elements: page.elements };
  }

  async act(_computer: unknown, request: BrowserActRequest): Promise<BrowserActResult> {
    let completed = 0;
    for (const action of request.actions) {
      const failed = await this.apply(action);
      if (failed) {
        const page = await this.snapshot();
        return { ok: false, completed, error: failed, ...page };
      }
      completed++;
    }
    return { ok: true, completed, ...(await this.snapshot()) };
  }

  private async apply(action: BrowserActRequest["actions"][number]): Promise<string | undefined> {
    const refs = this.page().elements.map((element) => element.ref);
    if (!action.ref || !refs.includes(action.ref))
      return `No element ${action.ref ?? ""} on this page`;
    if (action.kind === "fill" || action.kind === "type") {
      if (action.kind === "fill" && action.field === "password" && action.ref !== "e6")
        return `Element ${action.ref} is not a password field`;
      if (action.ref === "e1") this.email = action.text.trim();
      else if (action.ref === "e3") this.typed = action.text.trim();
      else if (action.ref === "e6") this.password = action.text;
      else return `Element ${action.ref} is not a text field`;
      return undefined;
    }
    if (action.kind !== "click") return `Unsupported action ${action.kind}`;
    if (action.ref === "e2") return this.options.login ? this.checkPassword() : this.sendCode();
    if (action.ref === "e4") return this.verify();
    if (action.ref === "e5") {
      this.step = "email";
      this.error = "";
      return undefined;
    }
    return undefined;
  }

  private checkPassword(): undefined {
    const { login } = this.options;
    this.state.emailsEntered.push(this.email);
    if (
      this.email.toLowerCase() === login?.email.toLowerCase() &&
      this.password === login.password &&
      !login.refusal
    ) {
      this.state.signedIn = true;
      this.error = "";
    } else this.error = login?.refusal ?? "Incorrect email or password.";
    return undefined;
  }

  private async sendCode(): Promise<undefined> {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email)) {
      this.error = "Enter a valid email address.";
      return undefined;
    }
    this.state.emailsEntered.push(this.email);
    this.code = String(randomInt(100_000, 1_000_000));
    this.step = "code";
    this.typed = "";
    this.error = "";
    this.state.codesSentTo.push(this.email);
    const { name, origin } = this.options;
    await this.deliver(this.email, {
      from: `no-reply@${new URL(origin).hostname}`,
      fromName: name,
      subject: `Your ${name} sign-in code`,
      text: `Hi,\n\nYour ${name} sign-in code is ${this.code}. It expires in 10 minutes.\n\nIf you didn't try to sign in, you can ignore this email.\n\nThe ${name} team`,
    });
    return undefined;
  }

  private verify(): undefined {
    this.state.codesTyped.push(this.typed);
    if (this.typed.replace(/\s+/g, "") === this.code) {
      this.state.signedIn = true;
      this.error = "";
    } else this.error = "That code is incorrect or has expired.";
    return undefined;
  }

  private url() {
    const path = this.state.signedIn ? "/dashboard" : this.step === "code" ? "/verify" : "/login";
    return `${this.options.origin}${path}`;
  }

  private page(): Page {
    const { name, dashboard } = this.options;
    const errors = this.error ? [this.error] : [];
    if (this.state.signedIn)
      return {
        title: `${name} dashboard`,
        text: [`Signed in as ${this.email}`, dashboard],
        elements: [],
      };
    if (this.step === "code")
      return {
        title: `Check your email | ${name}`,
        text: [`Enter the 6-digit code we emailed to ${this.email}.`, ...errors],
        elements: [
          { ref: "e3", role: "textbox", name: "Sign-in code", tag: "input", value: this.typed },
          { ref: "e4", role: "button", name: "Sign in", tag: "button" },
          { ref: "e5", role: "link", name: "Use a different email", tag: "a" },
        ],
      };
    if (this.options.login)
      return {
        title: `Sign in | ${name}`,
        text: [`Sign in to ${name}`, ...errors],
        elements: [
          { ref: "e1", role: "textbox", name: "Email", tag: "input", value: this.email },
          { ref: "e6", role: "textbox", name: "Password", tag: "input" },
          { ref: "e2", role: "button", name: "Sign in", tag: "button" },
        ],
      };
    return {
      title: `Sign in | ${name}`,
      text: [`Sign in to ${name}`, ...errors],
      elements: [
        { ref: "e1", role: "textbox", name: "Email", tag: "input", value: this.email },
        { ref: "e2", role: "button", name: "Email me a code", tag: "button" },
      ],
    };
  }
}
