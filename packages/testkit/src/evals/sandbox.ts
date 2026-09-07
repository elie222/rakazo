import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  ProcessEvent,
} from "@rakazo/adapter-kit";
import { FakeSandboxProvider } from "@rakazo/adapters";

/** A model must not receive successful shell results for commands the fixture never ran. */
export class EvalSandboxProvider extends FakeSandboxProvider {
  readonly harnessIssues: string[] = [];

  override async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (request.argv[3] === "rakazo-background-launch") {
      const issue = "Shell execution is unavailable in this offline eval sandbox.";
      if (!this.harnessIssues.includes(issue)) this.harnessIssues.push(issue);
      yield { type: "stderr", data: issue };
      yield { type: "exit", code: 127 };
      return;
    }
    yield* super.execute(computer, request, context);
  }
}
