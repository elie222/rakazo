import type { ComputerAction, ComputerInput } from "@rakazo/adapter-kit";
import { clampRounded, shellQuote } from "./computer-support.js";
export interface ExtraDisplayLayout {
  display: string;
  displayNumber: number;
}

export function observeExtraDisplayCommand(layout: ExtraDisplayLayout): string {
  const imagePath = `/tmp/rakazo/observe-${layout.displayNumber}.png`;
  return [
    `DISPLAY=${layout.display} xdotool getmouselocation --shell >/tmp/rakazo/cursor-${layout.displayNumber}.txt || true`,
    `DISPLAY=${layout.display} scrot -o ${imagePath} 2>/dev/null || DISPLAY=${layout.display} import -window root ${imagePath}`,
    `test -s ${imagePath}`,
    `base64 -w0 ${imagePath} 2>/dev/null || base64 ${imagePath}`,
    `printf '\\nCURSOR '`,
    `tr '\\n' ' ' </tmp/rakazo/cursor-${layout.displayNumber}.txt 2>/dev/null || true`,
  ].join("; ");
}

export function parseExtraDisplayObservation(output: string): {
  image: Uint8Array;
  cursor?: { x: number; y: number };
} {
  const cursorLine = output.match(/X=(\d+).*Y=(\d+)/);
  const base64Line =
    output
      .split(/\nCURSOR /)[0]
      ?.trim()
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const image = Uint8Array.from(Buffer.from(base64Line, "base64"));
  if (!image.byteLength) throw new Error("extra display observation did not capture an image");
  return {
    image,
    ...(cursorLine ? { cursor: { x: Number(cursorLine[1]), y: Number(cursorLine[2]) } } : {}),
  };
}

export function extraDisplayActionCommand(
  layout: ExtraDisplayLayout,
  action: ComputerAction,
): string {
  if (action.kind === "wait") {
    return `sleep ${clampRounded(action.ms, 0, 5_000) / 1000}`;
  }
  if (action.kind === "scroll") {
    const repeat = clampRounded(action.amount ?? 3, 1, 20);
    const button = action.direction === "up" ? "4" : "5";
    return `DISPLAY=${layout.display} xdotool click --repeat ${repeat} ${button}`;
  }
  if (action.kind === "key") {
    const keys = [...(action.modifiers ?? []), action.key].join("+");
    return `DISPLAY=${layout.display} xdotool key ${shellQuote(keys)}`;
  }
  if (action.kind === "clipboard") {
    return `DISPLAY=${layout.display} xdotool type ${shellQuote(action.text)}`;
  }
  if (action.kind === "pointer") {
    const button = action.button === "right" ? "3" : "1";
    if (action.type === "move") {
      return `DISPLAY=${layout.display} xdotool mousemove ${action.x} ${action.y}`;
    }
    if (action.type === "down") {
      return `DISPLAY=${layout.display} xdotool mousemove ${action.x} ${action.y} mousedown ${button}`;
    }
    if (action.type === "up") {
      return `DISPLAY=${layout.display} xdotool mousemove ${action.x} ${action.y} mouseup ${button}`;
    }
    return `DISPLAY=${layout.display} xdotool mousemove ${action.x} ${action.y} click ${button}`;
  }
  if (action.kind === "open") {
    return `DISPLAY=${layout.display} xdg-open ${shellQuote(action.path)}`;
  }
  return `DISPLAY=${layout.display} ${shellQuote(action.application)}${action.uri ? ` ${shellQuote(action.uri)}` : ""}`;
}

export function extraDisplayInputCommand(layout: ExtraDisplayLayout, input: ComputerInput): string {
  if (input.kind === "key") {
    return `DISPLAY=${layout.display} xdotool key ${shellQuote(input.key)}`;
  }
  if (input.kind === "clipboard") {
    return `DISPLAY=${layout.display} xdotool type ${shellQuote(input.text)}`;
  }
  const button = input.button === "right" ? "3" : "1";
  if (input.type === "move") {
    return `DISPLAY=${layout.display} xdotool mousemove ${input.x} ${input.y}`;
  }
  if (input.type === "down") {
    return `DISPLAY=${layout.display} xdotool mousemove ${input.x} ${input.y} mousedown ${button}`;
  }
  if (input.type === "up") {
    return `DISPLAY=${layout.display} xdotool mousemove ${input.x} ${input.y} mouseup ${button}`;
  }
  return `DISPLAY=${layout.display} xdotool mousemove ${input.x} ${input.y} click ${button}`;
}
