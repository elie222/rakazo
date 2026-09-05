import { Trans, useLingui } from "@lingui/react/macro";
import { signupRequiresEmailVerification } from "@rakazo/core";
import { Button, Input, Label } from "@rakazo/ui-web";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../lib/auth";
import { clearSpaceSelection } from "../lib/rpc";

type AuthMode = "in" | "up" | "forgot";
type PasswordResetCapabilities = { passwordReset: boolean; resetUrl: string | null };

const fieldClass = "mt-2 h-12 rounded-xl px-4 text-base md:text-base";
const submitClass = "mt-3 h-12 w-full rounded-xl text-base";

export function AuthPage({ mode }: { mode: AuthMode }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  // Signup triggers a session refresh that remounts the anonymous auth page.
  const sent = resetSent || searchParams.get("verify") === "email";
  const [reset, setReset] = useState<PasswordResetCapabilities | null>(null);
  const passwordFieldId = mode === "in" ? "current-password" : "new-password";
  const title = sent ? (
    <Trans>Check your email</Trans>
  ) : mode === "in" ? (
    <Trans>Sign in to Rakazo</Trans>
  ) : mode === "up" ? (
    <Trans>Create your Rakazo</Trans>
  ) : (
    <Trans>Reset your password</Trans>
  );

  useEffect(() => {
    if (mode === "up") return;
    let active = true;
    void fetch("/api/auth/capabilities")
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load authentication capabilities");
        return (await response.json()) as PasswordResetCapabilities;
      })
      .then((capabilities) => {
        if (active) setReset(capabilities);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (mode === "forgot") {
        if (!reset?.passwordReset || !reset.resetUrl) {
          setError(t`Password recovery is not configured for this server`);
          return;
        }
        const result = await authClient.requestPasswordReset({
          email: email.trim(),
          redirectTo: reset.resetUrl,
        });
        if (result.error) {
          setError(result.error.message ?? t`Could not send reset email`);
          return;
        }
        setResetSent(true);
        return;
      }
      const result =
        mode === "up"
          ? await authClient.signUp.email({
              email,
              password,
              name: name || email.split("@")[0] || "User",
            })
          : await authClient.signIn.email({ email, password });
      if (result.error) {
        setError(result.error.message ?? t`Could not continue`);
        return;
      }
      if (mode === "up" && signupRequiresEmailVerification(result.data)) {
        setSearchParams({ verify: "email" });
        return;
      }
      clearSpaceSelection();
      navigate(mode === "up" ? "/onboarding" : "/app");
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthFrame onSubmit={submit} title={title}>
      {sent ? (
        <div className="w-full text-center">
          <Link to="/sign-in" className="font-medium text-foreground">
            <Trans>Back to sign in</Trans>
          </Link>
        </div>
      ) : (
        <>
          {mode === "up" ? (
            <div className="mb-4 w-full">
              <Label htmlFor="name" className="text-muted-foreground">
                <Trans>Name</Trans>
              </Label>
              <Input
                id="name"
                name="name"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t`Your name`}
                className={fieldClass}
              />
            </div>
          ) : null}
          <div className="w-full">
            <Label htmlFor="email" className="text-muted-foreground">
              <Trans>Email</Trans>
            </Label>
            <Input
              id="email"
              name="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t`Your email address`}
              type="email"
              required
              className={fieldClass}
            />
          </div>
          {mode !== "forgot" ? (
            <div className="mt-4 w-full">
              <Label htmlFor={passwordFieldId} className="text-muted-foreground">
                <Trans>Password</Trans>
              </Label>
              <div className="relative">
                <Input
                  id={passwordFieldId}
                  name="password"
                  autoComplete={mode === "in" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t`Password`}
                  type={showPassword ? "text" : "password"}
                  required
                  minLength={8}
                  className={`${fieldClass} pr-12`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowPassword((shown) => !shown)}
                  aria-label={showPassword ? t`Hide password` : t`Show password`}
                  aria-pressed={showPassword}
                  className="absolute inset-y-0 right-2 my-auto text-muted-foreground"
                >
                  {showPassword ? <EyeOff /> : <Eye />}
                </Button>
              </div>
              {mode === "in" && reset?.passwordReset ? (
                <div className="mt-2 text-right text-sm">
                  <Link to="/forgot-password" className="font-medium text-foreground">
                    <Trans>Forgot password?</Trans>
                  </Link>
                </div>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 w-full text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="lg" disabled={pending} className={submitClass}>
            {pending ? (
              <Trans>Working…</Trans>
            ) : mode === "in" ? (
              <Trans>Continue with email</Trans>
            ) : mode === "forgot" ? (
              <Trans>Send reset link</Trans>
            ) : (
              <Trans>Create account</Trans>
            )}
          </Button>
          <p className="mt-8 text-muted-foreground">
            {mode === "in" ? (
              <>
                <Trans>Don’t have an account?</Trans>{" "}
                <Link to="/sign-up" className="font-medium text-foreground">
                  <Trans>Sign up</Trans>
                </Link>
              </>
            ) : mode === "up" ? (
              <>
                <Trans>Already have an account?</Trans>{" "}
                <Link to="/sign-in" className="font-medium text-foreground">
                  <Trans>Sign in</Trans>
                </Link>
              </>
            ) : (
              <Link to="/sign-in" className="font-medium text-foreground">
                <Trans>Back to sign in</Trans>
              </Link>
            )}
          </p>
        </>
      )}
    </AuthFrame>
  );
}

export function PasswordResetPage() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(
    params.get("error") || !params.get("token") ? t`This reset link is invalid or expired` : null,
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const token = params.get("token");
    if (!token) return;
    if (password !== confirmation) {
      setError(t`Passwords do not match`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        setError(result.error.message ?? t`Could not reset password`);
        return;
      }
      setComplete(true);
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthFrame onSubmit={submit} title={<Trans>Choose a new password</Trans>}>
      {complete ? (
        <div role="status" className="w-full text-center">
          <p className="text-lg">
            <Trans>Password updated</Trans>
          </p>
          <Link to="/sign-in" className="mt-6 inline-block font-medium">
            <Trans>Sign in</Trans>
          </Link>
        </div>
      ) : (
        <>
          <PasswordField
            id="new-password"
            label={t`New password`}
            value={password}
            onChange={setPassword}
          />
          <PasswordField
            id="confirm-password"
            label={t`Confirm password`}
            value={confirmation}
            onChange={setConfirmation}
            className="mt-4"
          />
          {error ? (
            <p role="alert" className="mt-3 w-full text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            disabled={pending || !params.get("token")}
            className={submitClass}
          >
            {pending ? <Trans>Working…</Trans> : <Trans>Reset password</Trans>}
          </Button>
          <Link to="/sign-in" className="mt-6 font-medium">
            <Trans>Back to sign in</Trans>
          </Link>
        </>
      )}
    </AuthFrame>
  );
}

function AuthFrame({
  title,
  onSubmit,
  children,
}: {
  title: React.ReactNode;
  onSubmit: (event: React.FormEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full items-center justify-center bg-background px-6 py-16 text-foreground">
      <form onSubmit={onSubmit} className="flex w-[460px] flex-col items-center">
        <div className="flex h-[74px] w-[74px] items-center justify-center gap-[11px] rounded-full bg-muted">
          <span className="h-5 w-[9px] rounded-full bg-primary" />
          <span className="h-5 w-[9px] rounded-full bg-primary" />
        </div>
        <h1 aria-live="polite" className="mb-9 mt-7 text-4xl font-medium tracking-tight">
          {title}
        </h1>
        {children}
      </form>
    </div>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  className = "",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={`w-full ${className}`}>
      <Label htmlFor={id} className="text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        name={id}
        autoComplete="new-password"
        type="password"
        required
        minLength={8}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={fieldClass}
      />
    </div>
  );
}
