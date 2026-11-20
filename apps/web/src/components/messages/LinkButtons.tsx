import { useExternalLinkOpener } from "@rakazo/chat-ui/web";
import type { LinkButton } from "@rakazo/contracts";
import { Button, buttonVariants } from "@rakazo/ui-web";

/** A bot post's link buttons. A web page opens as a chat link does; an app link hands off. */
export function LinkButtons({ buttons }: { buttons: LinkButton[] }) {
  const { open, dialog } = useExternalLinkOpener();
  return (
    <div className="flex min-w-0 flex-wrap gap-2">
      {buttons.map((button, index) => {
        const key = `${index}:${button.url}`;
        // No href on a web page, so no click of any kind skips the prompt.
        return button.url.startsWith("https:") ? (
          <Button
            key={key}
            variant="outline"
            size="sm"
            className="max-w-full"
            onClick={() => open(button.url)}
          >
            <span className="truncate">{button.label}</span>
          </Button>
        ) : (
          <a
            key={key}
            href={button.url}
            className={`${buttonVariants({ variant: "outline", size: "sm" })} max-w-full`}
          >
            <span className="truncate">{button.label}</span>
          </a>
        );
      })}
      {dialog}
    </div>
  );
}
