import type { ModelMark } from "@rakazo/core";
import { CpuIcon } from "lucide-react";

/** A model maker's mark in the text color, or a generic chip when the maker has none. */
export function ModelMarkIcon({ mark, className }: { mark?: ModelMark; className?: string }) {
  if (!mark) return <CpuIcon aria-hidden="true" className={className} />;
  return (
    <svg aria-hidden="true" viewBox={mark.viewBox} fill="currentColor" className={className}>
      <path
        d={mark.path}
        fillRule={mark.evenOdd ? "evenodd" : undefined}
        clipRule={mark.evenOdd ? "evenodd" : undefined}
      />
    </svg>
  );
}
