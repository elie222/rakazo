import { Trans } from "@lingui/react/macro";
import type { SignInProvider } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { Mail } from "lucide-react";

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
      {providers.map((provider) => (
        <Button
          key={provider.id}
          type="button"
          variant="outline"
          size="xl"
          disabled={disabled}
          className="w-full min-w-0 shadow-none"
          onClick={() => onPress(provider.id)}
        >
          {provider.presentation?.mark ? (
            <svg viewBox={provider.presentation.mark.viewBox} className="size-5" aria-hidden="true">
              {provider.presentation.mark.paths.map((path) => (
                <path key={path.d} d={path.d} fill="currentColor" />
              ))}
            </svg>
          ) : null}
          <span className="truncate">
            <Trans>Continue with {provider.name}</Trans>
          </span>
        </Button>
      ))}
      {onEmail ? (
        <Button
          type="button"
          variant="outline"
          size="xl"
          disabled={disabled}
          className="w-full min-w-0 shadow-none"
          onClick={onEmail}
        >
          <Mail />
          <Trans>Continue with email</Trans>
        </Button>
      ) : null}
    </div>
  );
}
