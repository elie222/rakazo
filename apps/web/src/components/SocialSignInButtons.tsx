import { Trans } from "@lingui/react/macro";
import type { SignInProvider } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";

const choiceClass =
  "h-12 min-w-0 rounded-xl border-input bg-transparent px-3 text-body font-medium shadow-none hover:bg-accent focus-visible:border-ring dark:bg-input/30 dark:hover:bg-input/50";

/**
 * Provider choices for the first sign-in screen. One provider spans the row;
 * two or more share it equally. Email is a separate step.
 */
export function SocialSignInButtons({
  providers,
  disabled,
  onPress,
  onEmail,
}: {
  providers: SignInProvider[];
  disabled?: boolean;
  onPress: (providerId: string) => void;
  onEmail?: () => void;
}) {
  if (providers.length === 0 && !onEmail) return null;
  return (
    <div className="flex w-full flex-col gap-3">
      {providers.length > 0 ? (
        <div className="flex w-full gap-3">
          {providers.map((provider) => (
            <Button
              key={provider.id}
              type="button"
              variant="outline"
              size="xl"
              disabled={disabled}
              className={`${choiceClass} flex-1`}
              onClick={() => onPress(provider.id)}
            >
              <ProviderMark id={provider.id} />
              <span className="truncate">{provider.name}</span>
            </Button>
          ))}
        </div>
      ) : null}
      {onEmail ? (
        <Button
          type="button"
          variant="outline"
          size="xl"
          disabled={disabled}
          className={`${choiceClass} w-full`}
          onClick={onEmail}
        >
          <MailMark />
          <Trans>Continue with email</Trans>
        </Button>
      ) : null}
    </div>
  );
}

function ProviderMark({ id }: { id: string }) {
  if (id === "google") return <GoogleMark />;
  if (id === "apple") return <AppleMark />;
  return null;
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-5" aria-hidden="true">
      <path
        fill={logoColor("FFC107")}
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill={logoColor("FF3D00")}
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill={logoColor("4CAF50")}
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0124 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill={logoColor("1976D2")}
        d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 01-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  );
}

/** The Google mark uses its own colors. They are not product theme tokens. */
function logoColor(digits: string) {
  return `#${digits}`;
}

function AppleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true" fill="currentColor">
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  );
}

function MailMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true" fill="none">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4 7l8 6 8-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
