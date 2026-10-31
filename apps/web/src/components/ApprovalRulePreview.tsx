import { Trans, useLingui } from "@lingui/react/macro";
import type {
  ActionApprovalRule,
  ApprovalRulePreview as Preview,
  SettingsScope,
} from "@rakazo/contracts";
import { Button, Input, ToggleGroup, ToggleGroupItem } from "@rakazo/ui-web";
import { useState } from "react";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";

/** A sample is evaluated on the server; this form never saves rules or invokes tools. */
export function ApprovalRulePreview({
  rule,
  scope,
}: {
  rule: ActionApprovalRule;
  scope: SettingsScope;
}) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const [tool, setTool] = useState(
    rule.matchKind === "tool" ? rule.matchValue : rule.matchKind === "site" ? "web_fetch" : "",
  );
  const [effect, setEffect] = useState<"always_allow" | "require_approval" | "deny" | "remove">(
    "remove",
  );
  const [result, setResult] = useState<Preview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = (source: Preview["before"]) =>
    source === "always_allow"
      ? t`Allow rule`
      : source === "deny"
        ? t`Block rule`
        : source === "require_approval"
          ? t`Ask rule`
          : t`No matching rule`;
  return (
    <form
      className="space-y-3 px-4 pb-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending) return;
        setPending(true);
        setResult(null);
        setError(null);
        try {
          setResult(
            await rpc.approvalRules.preview({
              scope,
              id: rule.id,
              effect,
              sample: {
                tools: [
                  {
                    name: tool.trim(),
                  },
                ],
                ...(rule.matchKind === "site" ? { site: rule.matchValue } : {}),
              },
            }),
          );
        } catch (err) {
          setError(errorText(err, t`Could not preview rule`));
        } finally {
          setPending(false);
        }
      }}
    >
      <Input
        aria-label={t`Tool name`}
        placeholder={t`Tool name`}
        value={tool}
        maxLength={200}
        disabled={pending}
        onChange={(event) => {
          setTool(event.target.value);
          setResult(null);
        }}
      />
      <ToggleGroup
        aria-label={t`Candidate rule`}
        value={[effect]}
        disabled={pending}
        onValueChange={([next]) => {
          if (
            next === "always_allow" ||
            next === "require_approval" ||
            next === "deny" ||
            next === "remove"
          ) {
            setEffect(next);
            setResult(null);
          }
        }}
      >
        {rule.matchKind !== "category" ? (
          <>
            <ToggleGroupItem value="always_allow">
              <Trans>Allow</Trans>
            </ToggleGroupItem>
            <ToggleGroupItem value="require_approval">
              <Trans>Ask</Trans>
            </ToggleGroupItem>
            <ToggleGroupItem value="deny">
              <Trans>Block</Trans>
            </ToggleGroupItem>
          </>
        ) : null}
        <ToggleGroupItem value="remove">
          <Trans>Remove</Trans>
        </ToggleGroupItem>
      </ToggleGroup>
      <Button type="submit" variant="outline" size="sm" disabled={pending || !tool.trim()}>
        <Trans>Test rule</Trans>
      </Button>
      {result ? (
        <p role="status" className="text-sm">
          <Trans>Current</Trans>: {label(result.before)} → <Trans>Preview</Trans>:{" "}
          {label(result.after)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
