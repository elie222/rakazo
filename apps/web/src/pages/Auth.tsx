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
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const passwordFieldId = mode === "in" ? "current-password" : "new-password";
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
        <div className="mt-4 w-full text-[16px] text-[#6E6E68]">
          <label htmlFor={passwordFieldId}>
            <Trans>Password</Trans>
          </label>
          <div className="relative mt-2">
            <input
              id={passwordFieldId}
              name="password"
              autoComplete={mode === "in" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t`Password`}
              type={showPassword ? "text" : "password"}
              required
              minLength={8}
              className="w-full rounded-[13px] border border-[#E4E4DE] bg-[#F1F1ED] py-[17px] pl-[18px] pr-[52px] text-[17px] text-[#1B1B1E] outline-none"
            />
            <button
              type="button"
              onClick={() => setShowPassword((shown) => !shown)}
              aria-label={showPassword ? t`Hide password` : t`Show password`}
              aria-pressed={showPassword}
              className="absolute inset-y-0 right-0 flex items-center px-[18px] text-[#8C8C86] hover:text-[#1B1B1E]"
            >
              {showPassword ? (
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                  <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                  <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                  <line x1="2" y1="2" x2="22" y2="22" />
                </svg>
              ) : (
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>
        </div>
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
