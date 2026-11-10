import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  ProcessEvent,
} from "@rakazo/adapter-kit";
import { computerObservation, FakeSandboxProvider } from "@rakazo/adapters";
import { PNG } from "pngjs";
import type { ComputerScript } from "./scripted-shell.js";
import { scriptedShell } from "./scripted-shell.js";

const SHELL_UNAVAILABLE = "Shell execution is unavailable in this offline eval sandbox.";

/** A model must not receive successful shell results for commands the fixture never ran. */
export class EvalSandboxProvider extends FakeSandboxProvider {
  readonly harnessIssues: string[] = [];
  private readonly screenImage?: Uint8Array;

  constructor(private readonly script?: ComputerScript) {
    super();
    if (script) this.screenImage = browserScreen(script.screen.dark);
  }

  override async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (request.argv[3] === "rakazo-background-launch") {
      const command = request.argv.at(-1) ?? "";
      const result = this.script && scriptedShell(this.script, command);
      if (result) {
        if (result.stdout) yield { type: "stdout", data: `${result.stdout}\n` };
        if (result.stderr) yield { type: "stderr", data: `${result.stderr}\n` };
        yield { type: "exit", code: result.code };
        return;
      }
      if (!this.harnessIssues.includes(SHELL_UNAVAILABLE))
        this.harnessIssues.push(SHELL_UNAVAILABLE);
      yield { type: "stderr", data: SHELL_UNAVAILABLE };
      yield { type: "exit", code: 127 };
      return;
    }
    yield* super.execute(computer, request, context);
  }

  override async observe(computer: ComputerRef, context: AdapterContext) {
    if (!this.script || !this.screenImage) return super.observe(computer, context);
    return computerObservation(this.screenImage, {
      mimeType: "image/png",
      width: SCREEN.width,
      height: SCREEN.height,
      activeWindow: { id: "browser", title: this.script.screen.title },
    });
  }
}

const SCREEN = { width: 640, height: 400 };

/** A browser window: a toolbar, then a page of text lines, light or dark. */
function browserScreen(dark: boolean): Uint8Array {
  const png = new PNG(SCREEN);
  const page = dark ? [24, 24, 27] : [255, 255, 255];
  const text = dark ? [200, 200, 205] : [40, 40, 45];
  const toolbar = [222, 225, 230];
  for (let y = 0; y < SCREEN.height; y++) {
    for (let x = 0; x < SCREEN.width; x++) {
      const line = y >= 80 && (y - 80) % 24 < 8 && x >= 40 && x < 40 + 520 - ((y * 7) % 160);
      const [r, g, b] = y < 48 ? toolbar : line ? text : page;
      const i = (y * SCREEN.width + x) * 4;
      png.data[i] = r!;
      png.data[i + 1] = g!;
      png.data[i + 2] = b!;
      png.data[i + 3] = 255;
    }
  }
  return new Uint8Array(PNG.sync.write(png));
}
