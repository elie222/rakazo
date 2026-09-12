import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  BotAvatar,
  GROK_BOT_COLORS,
  GrokShapePreview,
  parseBotAvatar,
} from "@rakazo/ui-web";
import { Check, Loader2, Pencil, Sparkles, Upload, X } from "lucide-react";
import { type ClipboardEvent, type DragEvent, useEffect, useRef, useState } from "react";

export interface AvatarStudioPopoverProps {
  value: string;
  identity?: string;
  status?: string;
  size?: number;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function AvatarStudioPopover({
  value,
  identity,
  status,
  size = 72,
  onChange,
  disabled = false,
}: AvatarStudioPopoverProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"bot" | "generate" | "upload">("bot");
  const [generatePrompt, setGeneratePrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const parsed = parseBotAvatar(value, identity);
  const currentColor = parsed.color || "#8B5CF6";
  const currentShape = parsed.shapeIndex ?? 0;

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  function handleShapeSelect(shapeIndex: number) {
    onChange(`${currentColor}::shape_${shapeIndex}`);
  }

  function handleColorSelect(color: string) {
    onChange(`${color}::shape_${currentShape}`);
  }

  function handleReset() {
    onChange("#8B5CF6::shape_0");
  }

  function processImageFile(file: File) {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const src = e.target?.result as string;
      if (!src) return;
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        const targetSize = 256;
        canvas.width = targetSize;
        canvas.height = targetSize;

        if (ctx) {
          ctx.beginPath();
          ctx.arc(targetSize / 2, targetSize / 2, targetSize / 2, 0, Math.PI * 2);
          ctx.clip();

          const minDim = Math.min(img.width, img.height);
          const sx = (img.width - minDim) / 2;
          const sy = (img.height - minDim) / 2;
          ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, targetSize, targetSize);

          const dataUrl = canvas.toDataURL("image/webp", 0.9);
          onChange(dataUrl);
          setOpen(false);
        }
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processImageFile(file);
  }

  function handlePaste(e: ClipboardEvent<HTMLDivElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item?.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          processImageFile(file);
          break;
        }
      }
    }
  }

  function handleGenerate() {
    if (!generatePrompt.trim() || generating) return;
    setGenerating(true);

    setTimeout(() => {
      try {
        const promptLower = generatePrompt.toLowerCase();
        let pickedColor: string = "#8B5CF6";
        if (promptLower.includes("blue") || promptLower.includes("cyan") || promptLower.includes("ice")) {
          pickedColor = "#3B82F6";
        } else if (promptLower.includes("green") || promptLower.includes("forest") || promptLower.includes("nature")) {
          pickedColor = "#10B981";
        } else if (promptLower.includes("purple") || promptLower.includes("violet")) {
          pickedColor = "#8B5CF6";
        } else if (promptLower.includes("red") || promptLower.includes("fire") || promptLower.includes("ruby")) {
          pickedColor = "#EF4444";
        } else if (promptLower.includes("yellow") || promptLower.includes("gold") || promptLower.includes("sun")) {
          pickedColor = "#EAB308";
        } else if (promptLower.includes("pink") || promptLower.includes("rose")) {
          pickedColor = "#EC4899";
        } else if (promptLower.includes("white") || promptLower.includes("silver") || promptLower.includes("light")) {
          pickedColor = "#FFFFFF";
        } else {
          let hash = 0;
          for (let i = 0; i < generatePrompt.length; i++) {
            hash = (hash << 5) - hash + generatePrompt.charCodeAt(i);
          }
          pickedColor = GROK_BOT_COLORS[Math.abs(hash) % GROK_BOT_COLORS.length] ?? "#8B5CF6";
        }

        let pickedShape = 0;
        if (promptLower.includes("hex") || promptLower.includes("polygon")) {
          pickedShape = 0;
        } else if (promptLower.includes("triangle") || promptLower.includes("wedge") || promptLower.includes("sharp")) {
          pickedShape = 1;
        } else if (promptLower.includes("box") || promptLower.includes("cube") || promptLower.includes("square")) {
          pickedShape = 2;
        } else if (promptLower.includes("pill") || promptLower.includes("capsule") || promptLower.includes("tablet")) {
          pickedShape = 3;
        } else if (promptLower.includes("pebble") || promptLower.includes("stone")) {
          pickedShape = 4;
        } else if (promptLower.includes("blob") || promptLower.includes("round") || promptLower.includes("circle")) {
          pickedShape = 5;
        } else if (promptLower.includes("drop") || promptLower.includes("tear") || promptLower.includes("water")) {
          pickedShape = 6;
        } else if (promptLower.includes("cloud") || promptLower.includes("soft") || promptLower.includes("puff")) {
          pickedShape = 7;
        } else {
          let hash = 0;
          for (let i = 0; i < generatePrompt.length; i++) {
            hash = (hash << 5) - hash + generatePrompt.charCodeAt(i);
          }
          pickedShape = Math.abs(hash) % 8;
        }

        onChange(`${pickedColor}::shape_${pickedShape}`);
        setGenerating(false);
        setActiveTab("bot");
      } catch {
        setGenerating(false);
      }
    }, 600);
  }

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="group relative cursor-pointer outline-none transition-transform hover:scale-[1.03] focus-visible:ring-2 focus-visible:ring-ring rounded-2xl"
        aria-label={t`Customize bot avatar`}
      >
        <BotAvatar color={value} identity={identity} size={size} status={status} />
        <div className="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full bg-[#202228] text-foreground border-2 border-[#141518] shadow-md transition-transform group-hover:scale-110">
          <Pencil size={12} strokeWidth={2.2} />
        </div>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4 animate-in fade-in duration-200"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-[360px] max-w-full rounded-3xl border border-white/[0.12] bg-[#141518] p-5 text-foreground shadow-2xl relative space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between">
              <span className="text-[14px] font-semibold text-foreground tracking-tight">
                <Trans>Avatar Studio</Trans>
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="size-7 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            {/* Live Character Preview */}
            <div className="flex flex-col items-center justify-center py-2">
              <BotAvatar color={value} identity={identity} size={78} status={status} />
            </div>

            {/* Segmented Tab Bar */}
            <div className="flex items-center justify-between pb-1 border-b border-border/40">
              <div className="flex items-center rounded-full bg-[#0E0F12] p-1 text-xs">
                <button
                  type="button"
                  onClick={() => setActiveTab("bot")}
                  className={`rounded-full px-3 py-1 font-medium transition-colors ${
                    activeTab === "bot"
                      ? "bg-[#252730] text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Trans>Bot</Trans>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab("generate")}
                  className={`rounded-full px-3 py-1 font-medium transition-colors ${
                    activeTab === "generate"
                      ? "bg-[#252730] text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Trans>Generate</Trans>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab("upload")}
                  className={`rounded-full px-3 py-1 font-medium transition-colors ${
                    activeTab === "upload"
                      ? "bg-[#252730] text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Trans>Upload</Trans>
                </button>
              </div>

              <button
                type="button"
                onClick={handleReset}
                className="text-xs font-medium text-muted-foreground/80 hover:text-foreground transition-colors px-2 py-1"
              >
                <Trans>Reset</Trans>
              </button>
            </div>

            {/* Tab: Bot Mascot Shapes & Colors */}
            {activeTab === "bot" && (
              <div className="space-y-4 pt-1">
                <div>
                  <div className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider mb-2">
                    <Trans>Shape</Trans>
                  </div>
                  <div className="grid grid-cols-4 gap-2 place-items-center">
                    {[0, 1, 2, 3, 4, 5, 6, 7].map((shapeIdx) => (
                      <GrokShapePreview
                        key={shapeIdx}
                        shapeIndex={shapeIdx}
                        color={currentColor}
                        selected={!parsed.isImage && currentShape === shapeIdx}
                        onClick={() => handleShapeSelect(shapeIdx)}
                      />
                    ))}
                  </div>
                </div>

                <div className="pt-2 border-t border-border/30">
                  <div className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider mb-2">
                    <Trans>Color</Trans>
                  </div>
                  <div className="grid grid-cols-6 gap-2 place-items-center">
                    {GROK_BOT_COLORS.map((color) => {
                      const isSelected = currentColor.toLowerCase() === color.toLowerCase() && !parsed.isImage;
                      return (
                        <button
                          key={color}
                          type="button"
                          onClick={() => handleColorSelect(color)}
                          aria-label={`Color ${color}`}
                          className={`size-6 rounded-full border transition-transform hover:scale-110 active:scale-95 ${
                            isSelected
                              ? "ring-2 ring-foreground ring-offset-2 ring-offset-[#141518] scale-105 border-transparent"
                              : "border-border/60"
                          }`}
                          style={{ backgroundColor: color }}
                        />
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Tab: Generate */}
            {activeTab === "generate" && (
              <div className="space-y-3 pt-1">
                <textarea
                  value={generatePrompt}
                  onChange={(e) => setGeneratePrompt(e.target.value)}
                  placeholder={t`Describe your avatar (e.g., emerald green wedge, staff white hexagon)...`}
                  rows={3}
                  className="w-full resize-none rounded-xl border border-border/50 bg-[#0E0F12] p-3 text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:border-ring focus:outline-none"
                />
                <button
                  type="button"
                  disabled={!generatePrompt.trim() || generating}
                  onClick={handleGenerate}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-foreground py-2 text-[13px] font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  {generating ? (
                    <>
                      <Loader2 size={15} className="animate-spin" />
                      <Trans>Generating…</Trans>
                    </>
                  ) : (
                    <>
                      <Sparkles size={15} />
                      <Trans>Generate Avatar</Trans>
                    </>
                  )}
                </button>
              </div>
            )}

            {/* Tab: Upload */}
            {activeTab === "upload" && (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onPaste={handlePaste}
                className={`flex flex-col items-center justify-center rounded-xl border border-dashed p-6 text-center transition-colors ${
                  dragOver
                    ? "border-primary bg-primary/10"
                    : "border-border/50 bg-[#0E0F12] hover:border-border"
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) processImageFile(file);
                  }}
                />
                <div className="mb-2 grid size-10 place-items-center rounded-full bg-[#18191E] text-muted-foreground">
                  <Upload size={18} strokeWidth={1.8} />
                </div>
                <p className="text-[12.5px] text-muted-foreground/90 font-medium">
                  <Trans>Drag, drop, or paste an image</Trans>
                </p>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-3 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-white/15 transition-colors"
                >
                  <Trans>Choose file</Trans>
                </button>
              </div>
            )}

            {/* Modal Footer: Done Button */}
            <div className="pt-3 border-t border-border/30 flex justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="flex items-center gap-1.5 rounded-xl bg-white/10 hover:bg-white/15 px-4 py-1.5 text-[13px] font-medium text-foreground transition-colors"
              >
                <Check size={14} />
                <Trans>Done</Trans>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
