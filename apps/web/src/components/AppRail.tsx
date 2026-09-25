import { useLingui } from "@lingui/react/macro";
import { Bot, Code2 } from "lucide-react";
import { Link } from "react-router-dom";

type AppRailProps = {
  active: "bots" | "artifacts";
};

export function AppRail({ active }: AppRailProps) {
  const { t } = useLingui();
  return (
    <nav
      data-testid="app-rail"
      aria-label={t`Sections`}
      className="flex w-14 shrink-0 flex-col items-center gap-1 border-e border-sidebar-border bg-sidebar py-3"
    >
      <RailLink to="/app" label={t`Bots`} active={active === "bots"}>
        <Bot size={19} strokeWidth={1.75} />
      </RailLink>
      <RailLink to="/app/artifacts" label={t`Artifacts`} active={active === "artifacts"}>
        <Code2 size={19} strokeWidth={1.75} />
      </RailLink>
    </nav>
  );
}

function RailLink({
  to,
  label,
  active,
  children,
}: {
  to: string;
  label: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={label}
      className={`flex h-10 w-10 items-center justify-center rounded-[11px] transition-colors ${
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
      }`}
    >
      {children}
    </Link>
  );
}
