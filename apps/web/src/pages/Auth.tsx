import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { authClient } from "../lib/auth";

export function AuthPage({ mode }: { mode: "in" | "up" }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const title =
    mode === "in" ? <Trans>Sign in to Rakazo</Trans> : <Trans>Create your Rakazo</Trans>;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const result =
      mode === "up"
        ? await authClient.signUp.email({
            email,
            password,
            name: name || email.split("@")[0] || "User",
          })
        : await authClient.signIn.email({ email, password });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? t`Could not continue`);
      return;
    }
    navigate(mode === "up" ? "/onboarding" : "/app");
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-[#F7F7F4] px-6 py-16 text-[#1B1B1E]">
      <form onSubmit={submit} className="flex w-[460px] flex-col items-center">
        <div className="flex h-[74px] w-[74px] items-center justify-center gap-[11px] rounded-full bg-[#16161A]">
          <span className="h-5 w-[9px] rounded-full bg-[#F7F7F4]" />
          <span className="h-5 w-[9px] rounded-full bg-[#F7F7F4]" />
        </div>
        <h1 className="mb-[38px] mt-[30px] text-[38px] tracking-[-0.02em]">{title}</h1>
        {mode === "up" ? (
          <label className="mb-4 w-full text-[16px] text-[#6E6E68]">
            <Trans>Name</Trans>
            <input
              id="name"
              name="name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t`Your name`}
              className="mt-2 w-full rounded-[13px] border border-[#E4E4DE] bg-[#F1F1ED] px-[18px] py-[17px] text-[17px] text-[#1B1B1E] outline-none"
            />
          </label>
        ) : null}
        <label className="w-full text-[16px] text-[#6E6E68]">
          <Trans>Email</Trans>
          <input
            id="email"
            name="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t`Your email address`}
            type="email"
            required
            className="mt-2 w-full rounded-[13px] border border-[#E4E4DE] bg-[#F1F1ED] px-[18px] py-[17px] text-[17px] text-[#1B1B1E] outline-none"
          />
        </label>
        <label className="mt-4 w-full text-[16px] text-[#6E6E68]">
          <Trans>Password</Trans>
          <input
            id={mode === "in" ? "current-password" : "new-password"}
            name="password"
            autoComplete={mode === "in" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t`Password`}
            type="password"
            required
            minLength={8}
            className="mt-2 w-full rounded-[13px] border border-[#E4E4DE] bg-[#F1F1ED] px-[18px] py-[17px] text-[17px] text-[#1B1B1E] outline-none"
          />
        </label>
        {error ? <p className="mt-3 w-full text-sm text-[#C94244]">{error}</p> : null}
        <button
          type="submit"
          disabled={pending}
          className="mt-3 w-full rounded-[13px] bg-[#121215] py-[18px] text-center text-[17px] font-medium text-[#FBFBF9] hover:bg-[#26262B]"
        >
          {pending ? (
            <Trans>Working…</Trans>
          ) : mode === "in" ? (
            <Trans>Continue with email</Trans>
          ) : (
            <Trans>Create account</Trans>
          )}
        </button>
        <p className="mt-[30px] text-[16px] text-[#8C8C86]">
          {mode === "in" ? (
            <>
              <Trans>Don’t have an account?</Trans>{" "}
              <Link to="/sign-up" className="font-medium text-[#1B1B1E]">
                <Trans>Sign up</Trans>
              </Link>
            </>
          ) : (
            <>
              <Trans>Already have an account?</Trans>{" "}
              <Link to="/sign-in" className="font-medium text-[#1B1B1E]">
                <Trans>Sign in</Trans>
              </Link>
            </>
          )}
        </p>
      </form>
    </div>
  );
}
