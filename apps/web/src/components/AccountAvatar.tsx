import { cn } from "@rakazo/ui-web";
import { UserRound } from "lucide-react";
import { useState } from "react";

export function AccountAvatar({
  image,
  initials,
  className,
}: {
  image?: string | null;
  initials: string | null;
  className?: string;
}) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-sidebar-accent font-medium text-foreground",
        className,
      )}
    >
      {image && failedImage !== image ? (
        <img
          src={image}
          alt=""
          className="size-full object-cover"
          onError={() => setFailedImage(image)}
        />
      ) : initials ? (
        initials
      ) : (
        <UserRound className="size-1/2" aria-hidden="true" />
      )}
    </span>
  );
}
