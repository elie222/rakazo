import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  ProcessEvent,
} from "@rakazo/adapter-kit";
import { computerObservation, FakeSandboxProvider } from "@rakazo/adapters";
import { PNG } from "pngjs";

/**
 * The state of an eval computer, for cases where the bot may check its own earlier work. Shell
 * commands get output consistent with that state; screenshots show its browser window.
 */
export interface ComputerScript {
  /**
   * Output for commands that mention a pattern. Every matching entry contributes, in order, so a
   * compound command that checks several things gets each answer. A command no entry matches
   * stays unavailable, as without a script.
   */
  shell: Array<{ match: RegExp; output: string }>;
  /** The browser window screenshots show: its title and whether its page renders dark. */
  screen: { title: string; dark: boolean };
}

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
      const output = this.script?.shell
        .filter((entry) => entry.match.test(command))
        .map((entry) => entry.output);
      if (output?.length) {
        yield { type: "stdout", data: `${output.join("\n")}\n` };
        yield { type: "exit", code: 0 };
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
