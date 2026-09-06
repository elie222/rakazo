import { Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { Camera, File, Image, Plus } from "lucide-react";
import type { RefObject } from "react";

export function AttachmentMenu({
  inputRef,
  accept,
  disabled,
  onPick,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  accept: string;
  disabled?: boolean;
  onPick: (files: FileList | null) => void | Promise<void>;
}) {
  const { t } = useLingui();
  function pick(kind: "image" | "camera" | "file") {
    const input = inputRef.current;
    if (!input) return;
    input.value = "";
    input.accept =
      kind === "file"
        ? accept
        : accept
            .split(",")
            .filter((type) => type.startsWith("image/"))
            .join(",");
    input.multiple = kind !== "camera";
    if (kind === "camera") input.setAttribute("capture", "environment");
    else input.removeAttribute("capture");
    input.click();
  }
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        className="hidden"
        onChange={(event) => void onPick(event.target.files)}
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t`Attach file`}
          disabled={disabled}
          render={
            <Button variant="outline" size="icon" className="rounded-full text-foreground/75" />
          }
        >
          <Plus size={17} strokeWidth={1.8} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="min-w-56 rounded-3xl p-2">
          <DropdownMenuItem className="min-h-12 gap-3 rounded-2xl" onClick={() => pick("image")}>
            <Image size={19} />
            <Trans>Attach image</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem className="min-h-12 gap-3 rounded-2xl" onClick={() => pick("camera")}>
            <Camera size={19} />
            <Trans>Take photo</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem className="min-h-12 gap-3 rounded-2xl" onClick={() => pick("file")}>
            <File size={19} />
            <Trans>Choose file</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
