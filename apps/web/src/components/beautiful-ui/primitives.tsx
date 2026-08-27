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

/** Format wall-clock seconds since `startedAtMs` as `0.0s` / `1m 2.3s`. */
export function formatElapsed(startedAtMs: number, nowMs: number): string {
  const totalTenths = Math.round(Math.max(0, nowMs - startedAtMs) / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = (totalTenths % 600) / 10;
  if (minutes === 0) return `${seconds.toFixed(1)}s`;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

function useElapsed(startedAtMs?: number): string {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);
  return formatElapsed(startedAtMs ?? mountedAt, now);
}

/** Pixel-grid loader with shimmering label and live elapsed timer. */
function DefaultLoadingState({ label, startedAt }: { label: string; startedAt?: number }) {
  const elapsed = useElapsed(startedAt);
  return (
    <>
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
    </>
  );
}

export function LoadingState({
  indicator,
  label = "working",
  startedAt,
}: {
  indicator?: React.ReactNode;
  label?: string;
  /** Epoch ms when the run started. Falls back to mount time when omitted. */
  startedAt?: number;
}) {
  if (indicator) {
    return (
      <span role="status" className="flex w-fit items-center gap-2.5">
        <span className="sr-only">{label}</span>
        {indicator}
      </span>
    );
  }
  return (
    <span className="flex w-fit items-center gap-2.5">
      <DefaultLoadingState label={label} startedAt={startedAt} />
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
