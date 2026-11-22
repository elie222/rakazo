import { accountDisplay } from "@rakazo/core";
import type { ReactNode } from "react";
import { useState } from "react";

/** A person in a members list: their picture or initial, name and address, then `trailing`. */
export function PersonRow({
  person,
  badge,
  trailing,
}: {
  person: { name: string; email: string; image: string | null };
  badge?: ReactNode;
  trailing?: ReactNode;
}) {
  const display = accountDisplay(person, person.email);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-muted text-body font-medium text-foreground"
      >
        {display.image && failedImage !== display.image ? (
          <img
            src={display.image}
            alt=""
            className="size-full object-cover"
            onError={() => setFailedImage(display.image)}
          />
        ) : (
          display.initial
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-body text-foreground">{display.label}</span>
          {badge}
        </div>
        {display.label !== person.email ? (
          <p className="truncate text-body-sm text-muted-foreground">{person.email}</p>
        ) : null}
      </div>
      {trailing}
    </li>
  );
}
