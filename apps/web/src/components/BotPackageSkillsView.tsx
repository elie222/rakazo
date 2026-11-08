import { Trans, useLingui } from "@lingui/react/macro";
import type { BotPackageReceipt, BotPackageSkillReceipt } from "@rakazo/contracts";
import { Button, Input } from "@rakazo/ui-web";
import { useId, useState } from "react";

function SkillRow({
  skill,
  disabled,
  onActivate,
}: {
  skill: BotPackageSkillReceipt;
  disabled: boolean;
  onActivate(name: string): void;
}) {
  const { t } = useLingui();
  const id = useId();
  const [name, setName] = useState(skill.name);
  return (
    <details className="rounded-lg border p-3">
      <summary className="cursor-pointer" dir="auto">
        {skill.name} ·{" "}
        {skill.status === "activated"
          ? t`Enabled`
          : skill.status === "removed"
            ? t`Removed`
            : t`Pending`}
      </summary>
      <pre
        className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-label"
        dir="auto"
      >
        {skill.content}
      </pre>
      {skill.status === "pending" ? (
        <div className="mt-3 space-y-2">
          <label htmlFor={id} className="block text-body">
            <Trans>Skill name</Trans>
            <Input
              id={id}
              aria-label={t`Skill name`}
              value={name}
              maxLength={80}
              disabled={disabled}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <Button
            variant="outline"
            disabled={disabled || !name.trim()}
            onClick={() => onActivate(name.trim())}
          >
            <Trans>Enable shared skill</Trans>
          </Button>
        </div>
      ) : null}
    </details>
  );
}

export function BotPackageSkillsView({
  receipt,
  busy,
  unknown,
  error,
  onActivate,
  onRefresh,
}: {
  receipt: BotPackageReceipt;
  busy: boolean;
  unknown: boolean;
  error: boolean;
  onActivate(componentId: string, name: string): void;
  onRefresh(): void;
}) {
  if (!receipt.skills.length) return null;
  return (
    <section className="mt-4 space-y-3" data-testid="bot-package-skills">
      <h3 className="font-medium">
        <Trans>Imported skills</Trans>
      </h3>
      <p className="text-body text-muted-foreground">
        <Trans>Enabling a skill shares it with your bots in this space.</Trans>
      </p>
      {error ? (
        <p role="alert" className="text-body text-destructive">
          <Trans>Could not enable skill. Check status or choose another name.</Trans>
        </p>
      ) : null}
      {receipt.skills.map((skill) => (
        <SkillRow
          key={`${skill.id}:${skill.revision}`}
          skill={skill}
          disabled={busy || unknown || receipt.status !== "completed"}
          onActivate={(name) => onActivate(skill.id, name)}
        />
      ))}
      {unknown || error ? (
        <Button variant="outline" disabled={busy} onClick={onRefresh}>
          <Trans>Check status</Trans>
        </Button>
      ) : null}
    </section>
  );
}
