import { Trans } from "@lingui/react/macro";
import type { BotPackageDocument, BotPackageLeftOut } from "@rakazo/contracts";

const rawClass =
  "mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 font-mono text-label";

export function BotPackageLeftOutList({ items }: { items: BotPackageLeftOut[] }) {
  if (!items.length) return null;
  return (
    <section className="mt-4" data-testid="bot-package-left-out">
      <h3 className="font-medium">
        <Trans>Not imported</Trans>
      </h3>
      <ul className="mt-2 space-y-2 text-body">
        {items.map((item, index) => (
          <li key={`${item.kind}:${index}`}>
            <span dir="auto">{item.name}</span>
            <p className="text-muted-foreground" dir="auto">
              {item.reason}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** External prompts remain selectable plain text throughout review. */
export function BotPackageDocumentView({ document }: { document: BotPackageDocument }) {
  return (
    <section className="space-y-3 text-body" data-testid="bot-package-document">
      <h2 className="text-heading3 font-medium" dir="auto">
        {document.profile.name}
      </h2>
      {document.profile.title ? <p dir="auto">{document.profile.title}</p> : null}
      {document.profile.description ? (
        <p className="whitespace-pre-wrap text-muted-foreground" dir="auto">
          {document.profile.description}
        </p>
      ) : null}
      <details open>
        <summary className="cursor-pointer">
          <Trans>Instructions</Trans>
        </summary>
        <pre className={rawClass} dir="auto">
          {document.profile.instructions}
        </pre>
      </details>
      <details>
        <summary className="cursor-pointer">
          <Trans>Skills</Trans> · {document.skills.length}
        </summary>
        {document.skills.map((skill, index) => (
          <details key={`${skill.name}:${index}`} className="mt-2 ps-3">
            <summary className="cursor-pointer" dir="auto">
              {skill.name}
            </summary>
            <pre className={rawClass} dir="auto">
              {skill.content}
            </pre>
          </details>
        ))}
      </details>
      <details>
        <summary className="cursor-pointer">
          <Trans>Routines</Trans> · {document.routines.length}
        </summary>
        {document.routines.map((routine, index) => (
          <details key={`${routine.name}:${index}`} className="mt-2 ps-3">
            <summary className="cursor-pointer" dir="auto">
              {routine.name}
            </summary>
            <p className="mt-2 text-muted-foreground">
              {routine.crons.join("; ")} · {routine.timezone}
            </p>
            <pre className={rawClass} dir="auto">
              {routine.prompt}
            </pre>
          </details>
        ))}
      </details>
      <details>
        <summary className="cursor-pointer">
          <Trans>Connections</Trans> · {document.connections.length}
        </summary>
        <ul className="mt-2 space-y-2 ps-3">
          {document.connections.map((connection, index) => (
            <li key={`${connection.name}:${index}`} dir="auto">
              {connection.name}
              <p className="text-muted-foreground">{connection.note}</p>
            </li>
          ))}
        </ul>
      </details>
      {document.memory.length ? (
        <details>
          <summary className="cursor-pointer">
            <Trans>Memory</Trans> · {document.memory.length}
          </summary>
          {document.memory.map((entry) => (
            <details key={entry.path} className="mt-2 ps-3">
              <summary className="cursor-pointer" dir="auto">
                {entry.path}
              </summary>
              <pre className={rawClass} dir="auto">
                {entry.content}
              </pre>
            </details>
          ))}
        </details>
      ) : null}
    </section>
  );
}
