import { Trans } from "@lingui/react/macro";
import type { SkillPlaybook } from "@rakazo/contracts";
import { formatSkillRunPrompt } from "@rakazo/core";
import { Button, Input, Label, Textarea } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";

type SkillDraftBlock = {
  kind: "skill_draft";
  skillId: string;
  name: string;
  goal: string;
  playbook: SkillPlaybook;
  status: "draft" | "saved";
};

function fieldLabel(id: string, title: React.ReactNode) {
  return (
    <Label htmlFor={id} className="mt-3 mb-1 text-[13px] font-normal text-muted-foreground">
      {title}
    </Label>
  );
}

export function SkillDraftCard({
  block,
  onRefresh,
  onAddRoutine,
}: {
  block: SkillDraftBlock;
  onRefresh: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
}) {
  const [name, setName] = useState(block.name);
  const [playbook, setPlaybook] = useState(block.playbook);
  const [saved, setSaved] = useState(block.status === "saved");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(block.name);
    setPlaybook(block.playbook);
    setSaved(block.status === "saved");
  }, [block.skillId, block.status]);

  async function saveDraft() {
    setBusy(true);
    try {
      await rpc.skills.updateDraft({ skillId: block.skillId, name, playbook });
      await rpc.skills.save({ skillId: block.skillId, name });
      setSaved(true);
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function testDraft() {
    setBusy(true);
    try {
      await rpc.skills.updateDraft({ skillId: block.skillId, name, playbook });
      await rpc.skills.testRun({ skillId: block.skillId });
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  const skillName = name || block.name || block.goal.slice(0, 80);

  return (
    <div
      data-testid="skill-draft-card"
      className="w-[min(520px,92%)] rounded-2xl border border-border bg-card px-5 py-4"
    >
      <div className="text-[15px] font-medium text-foreground">
        <Trans>Draft skill</Trans>
      </div>
      <div className="mt-1 text-[13.5px] text-muted-foreground">{block.goal}</div>
      {fieldLabel("skill-draft-name", <Trans>Name</Trans>)}
      <Input id="skill-draft-name" value={name} onChange={(event) => setName(event.target.value)} />
      {fieldLabel("skill-draft-when", <Trans>When to use</Trans>)}
      <Textarea
        id="skill-draft-when"
        value={playbook.whenToUse}
        onChange={(event) => setPlaybook({ ...playbook, whenToUse: event.target.value })}
        rows={2}
      />
      {fieldLabel("skill-draft-inputs", <Trans>Inputs</Trans>)}
      <Textarea
        id="skill-draft-inputs"
        value={playbook.inputs.join("\n")}
        onChange={(event) =>
          setPlaybook({
            ...playbook,
            inputs: event.target.value.split("\n"),
          })
        }
        rows={2}
      />
      {fieldLabel("skill-draft-steps", <Trans>Steps</Trans>)}
      <Textarea
        id="skill-draft-steps"
        value={playbook.steps.join("\n")}
        onChange={(event) =>
          setPlaybook({
            ...playbook,
            steps: event.target.value.split("\n"),
          })
        }
        rows={5}
      />
      {fieldLabel("skill-draft-check", <Trans>How to check</Trans>)}
      <Textarea
        id="skill-draft-check"
        value={playbook.howToCheck}
        onChange={(event) => setPlaybook({ ...playbook, howToCheck: event.target.value })}
        rows={2}
      />
      {fieldLabel("skill-draft-return", <Trans>What to return</Trans>)}
      <Textarea
        id="skill-draft-return"
        value={playbook.whatToReturn}
        onChange={(event) => setPlaybook({ ...playbook, whatToReturn: event.target.value })}
        rows={2}
      />
      {fieldLabel("skill-draft-approval", <Trans>Approval boundaries</Trans>)}
      <Textarea
        id="skill-draft-approval"
        value={playbook.approvalBoundaries}
        onChange={(event) => setPlaybook({ ...playbook, approvalBoundaries: event.target.value })}
        rows={2}
      />
      {fieldLabel("skill-draft-failure", <Trans>Failure handling</Trans>)}
      <Textarea
        id="skill-draft-failure"
        value={playbook.failureHandling}
        onChange={(event) => setPlaybook({ ...playbook, failureHandling: event.target.value })}
        rows={2}
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void saveDraft()}>
          {saved ? <Trans>Saved</Trans> : busy ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void testDraft()}>
          <Trans>Test</Trans>
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => onAddRoutine(skillName, formatSkillRunPrompt(skillName, playbook))}
        >
          <Trans>Add to routine</Trans>
        </Button>
      </div>
    </div>
  );
}
