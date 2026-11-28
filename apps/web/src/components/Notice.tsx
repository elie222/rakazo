import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

const tones = {
  error: {
    role: "alert",
    Icon: CircleAlert,
    box: "border-destructive/40 bg-destructive/10",
    icon: "text-destructive",
  },
  warning: {
    role: "status",
    Icon: TriangleAlert,
    box: "border-warning/40 bg-warning/10",
    icon: "text-warning",
  },
  success: {
    role: "status",
    Icon: CircleCheck,
    box: "border-success/40 bg-success/10",
    icon: "text-success",
  },
} as const;

/** A tinted message box: the tone's icon carries the colour, so the text stays readable. */
export function Notice({
  tone,
  className = "",
  children,
}: {
  tone: keyof typeof tones;
  className?: string;
  children: ReactNode;
}) {
  const { role, Icon, box, icon } = tones[tone];
  return (
    <div
      role={role}
      className={`flex gap-2.5 rounded-lg border px-3 py-2.5 text-body-sm ${box} ${className}`}
    >
      <Icon aria-hidden className={`mt-px size-4 shrink-0 ${icon}`} strokeWidth={1.75} />
      <p className="min-w-0 break-words">{children}</p>
    </div>
  );
}
