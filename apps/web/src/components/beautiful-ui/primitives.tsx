import { useEffect, useState } from "react";
import "./beautiful-ui.css";

/* Beautiful UI primitives — hand-ported from beautifului.dev
   (github.com/TurboKach/ai-native-react-components, MIT © 2026 Turbo).
   The upstream components are demo showcases; these ports keep their visual
   and motion language (pixel-grid loader, shimmer sweep, pop-in success) and
   expose real props. */

/** A light sweep travelling across a text label. */
export function Shimmer({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="bg-clip-text text-transparent"
      style={{
        backgroundImage:
          "linear-gradient(90deg, var(--bui-ink-3) 35%, var(--bui-ink) 50%, var(--bui-ink-3) 65%)",
        backgroundSize: "200% 100%",
        animation: "bui-shimmer-text 1.4s linear infinite",
      }}
    >
      {children}
    </span>
  );
}

// Chevron wavefront: each 3×3 cell fires by column distance from the center row.
const CHEVRON_DELAYS = Array.from({ length: 9 }, (_, i) => {
  const row = Math.floor(i / 3);
  const column = i % 3;
  return (column + Math.abs(row - 1)) * 90;
});

function useElapsed(): string {
  const [deciseconds, setDeciseconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setDeciseconds((value) => value + 1), 100);
    return () => clearInterval(timer);
  }, []);
  const total = deciseconds / 10;
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

/** Pixel-grid loader with shimmering label and live elapsed timer. */
export function LoadingState({ label = "working" }: { label?: string }) {
  const elapsed = useElapsed();
  return (
    <span className="flex w-fit items-center gap-2.5">
      <span aria-hidden className="grid grid-cols-[repeat(3,4px)] gap-[1.5px]">
        {CHEVRON_DELAYS.map((delay, i) => (
          <span
            key={i}
            className="h-[4px] w-[4px] rounded-[1px]"
            style={{
              background: "var(--bui-ink)",
              opacity: 0.15,
              animation: `bui-pixel-on 650ms ease-in-out ${delay}ms infinite`,
            }}
          />
        ))}
      </span>
      <span className="text-[13.5px] font-medium">
        <Shimmer>{label}</Shimmer>
      </span>
      <span className="font-mono text-[12px] tabular-nums" style={{ color: "var(--bui-ink-3)" }}>
        {elapsed}
      </span>
    </span>
  );
}

/** Pop-in green check with a fading-up label — the approval-card success beat. */
export function SuccessPop({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span
        className="flex h-6 w-6 items-center justify-center rounded-full text-white"
        style={{
          background: "var(--bui-green)",
          animation: "bui-pop-in 300ms cubic-bezier(0.23,1,0.32,1) both",
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </span>
      <span
        className="text-[13px] font-medium"
        style={{
          color: "var(--bui-ink)",
          animation: "bui-fade-up 350ms cubic-bezier(0.23,1,0.32,1) 100ms both",
        }}
      >
        {label}
      </span>
    </span>
  );
}

/** Card shell with Beautiful UI's surface + layered shadow treatment. */
export function BuiCard({
  children,
  className = "",
  style,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      {...props}
      className={`rounded-[16px] ${className}`}
      style={{ background: "var(--bui-surface)", boxShadow: "var(--bui-shadow-card)", ...style }}
    >
      {children}
    </div>
  );
}

/** Primary pill button in the Beautiful UI control style. */
export function BuiButton({
  children,
  onClick,
  disabled,
  tone = "neutral",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  tone?: "neutral" | "accent";
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-full px-4 py-2 text-[13.5px] font-medium transition-colors duration-150 disabled:opacity-60"
      style={
        tone === "accent"
          ? { background: "var(--bui-accent)", color: "#090a12" }
          : {
              background: "var(--bui-hover)",
              color: "var(--bui-ink)",
              boxShadow: "var(--bui-shadow-btn)",
            }
      }
    >
      {children}
    </button>
  );
}
