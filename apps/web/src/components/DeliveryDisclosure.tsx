import type { MessageBlock } from "@rakazo/contracts";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { ChevronRight, Mail, MessageSquare, Webhook } from "lucide-react";
import type { ReactNode } from "react";

type DeliveryBlock = Extract<MessageBlock, { kind: "delivery" }>;

const SOURCE_ICONS = { webhook: Webhook, email: Mail, messaging: MessageSquare } as const;

/**
 * An event that woke the bot: one muted line naming it, with the full prompt the bot was given
 * (routines and payload) folded under it.
 */
export function DeliveryDisclosure({
  block,
  text,
  quoteMessageId,
  children,
}: {
  block: DeliveryBlock;
  text: string;
  quoteMessageId?: string;
  /** Hover actions, anchored on the line. */
  children?: ReactNode;
}) {
  const Icon = SOURCE_ICONS[block.source];
  return (
    <Collapsible
      data-testid="delivery-message"
      className="group relative flex w-full max-w-full flex-col items-end"
    >
      <div className="relative flex max-w-full items-center">
        <CollapsibleTrigger className="flex min-h-6 max-w-full cursor-pointer items-center gap-1.5 rounded-md py-0.5 ps-1.5 text-body-sm text-muted-foreground outline-none hover:text-foreground/75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
          <Icon aria-hidden size={14} strokeWidth={1.8} className="shrink-0" />
          <span className="min-w-0 truncate" dir="auto">
            {block.title}
          </span>
          <ChevronRight
            aria-hidden
            size={14}
            strokeWidth={1.8}
            className="shrink-0 transition-transform duration-150 group-data-panel-open:rotate-90 motion-reduce:transition-none"
          />
        </CollapsibleTrigger>
        {children}
      </div>
      <CollapsibleContent hiddenUntilFound className="w-full">
        <pre
          data-testid="delivery-message-prompt"
          data-quote-message-id={quoteMessageId}
          className="mt-1 max-h-96 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-xl bg-muted px-3.5 py-2.5 font-mono text-body-sm text-foreground/80"
          dir="auto"
        >
          {text}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
