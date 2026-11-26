import { useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { ExternalLink } from "lucide-react";
import { useState } from "react";

type ResultCardsBlock = Extract<MessageBlock, { kind: "result_cards" }>;

function safeExternalUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function CardThumbnail({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <div className="aspect-[16/10] w-full overflow-hidden bg-muted">
      <img
        src={src}
        alt={alt}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="size-full object-cover"
      />
    </div>
  );
}

export function ResultCards({ block }: { block: ResultCardsBlock }) {
  const { t } = useLingui();
  return (
    <div data-testid="result-cards" className="w-full min-w-0 space-y-2">
      {block.title ? (
        <div className="text-body-sm font-medium text-muted-foreground">{block.title}</div>
      ) : null}
      <ul
        aria-label={block.title ?? t`Results`}
        className="m-0 flex list-none snap-x snap-mandatory gap-3 overflow-x-auto p-0 pb-1"
      >
        {block.items.map((item, index) => {
          const href = safeExternalUrl(item.url);
          const imageSrc = safeExternalUrl(item.imageUrl);
          const inner = (
            <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card text-foreground transition-colors hover:border-foreground/20">
              {imageSrc ? <CardThumbnail src={imageSrc} alt={item.title} /> : null}
              <div className="flex flex-1 flex-col gap-1.5 p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="line-clamp-2 text-body font-semibold text-foreground">
                    {item.title}
                  </div>
                  {href ? (
                    <ExternalLink
                      aria-hidden="true"
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    />
                  ) : null}
                </div>
                {item.subtitle ? (
                  <div className="line-clamp-2 text-body-sm text-muted-foreground">
                    {item.subtitle}
                  </div>
                ) : null}
                {item.price || item.rating ? (
                  <div className="mt-auto flex items-center gap-2 pt-1 text-body-sm">
                    {item.price ? (
                      <span className="font-semibold tabular-nums text-foreground">
                        {item.price}
                      </span>
                    ) : null}
                    {item.rating ? (
                      <span className="tabular-nums text-muted-foreground">{item.rating}</span>
                    ) : null}
                  </div>
                ) : null}
                {item.badges && item.badges.length > 0 ? (
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {item.badges.map((badge) => (
                      <span
                        key={badge}
                        className="rounded-md bg-muted px-1.5 py-0.5 text-caption text-muted-foreground"
                      >
                        {badge}
                      </span>
                    ))}
                  </div>
                ) : null}
                {item.meta ? (
                  <div className="truncate text-caption text-muted-foreground">{item.meta}</div>
                ) : null}
              </div>
            </div>
          );
          return (
            <li key={`${item.title}-${index}`} className="w-60 shrink-0 snap-start">
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block h-full rounded-2xl focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {inner}
                </a>
              ) : (
                inner
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
