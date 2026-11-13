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
  const alone = providers.length === 1;
  return (
    <div className="flex w-full flex-col items-center">
      {providers.length > 0 ? (
        <div className={alone ? "w-full" : "flex w-full flex-col gap-3 sm:flex-row"}>
          {providers.map((provider) => (
            <Button
              key={provider.id}
              type="button"
              variant={provider.presentation?.variant === "outline" ? "outline" : "default"}
              size="xl"
              disabled={disabled}
              className={`${alone ? "w-full" : "w-full sm:w-auto sm:flex-1"} shadow-none`}
              onClick={() => onPress(provider.id)}
            >
              {provider.presentation?.mark ? (
                <svg
                  viewBox={provider.presentation.mark.viewBox}
                  className="size-5"
                  aria-hidden="true"
                >
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
        </div>
      ) : null}
      {onEmail ? (
        <>
          <div className="my-5 flex w-full items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="text-body-sm text-muted-foreground">
              <Trans>or</Trans>
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button
            type="button"
            variant="text"
            size="sm"
            disabled={disabled}
            className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={onEmail}
          >
            <Mail />
            <Trans>Continue with email</Trans>
          </Button>
        </>
      ) : null}
    </div>
  );
}
