import { describe, expect, it } from "vitest";
import { fitRoutineList, readRoutine } from "./routine-list-view.js";

const steps = Array.from({ length: 200 }, (_, index) => `Step ${index + 1}: check "it".\n`);
const longPrompt = steps.join("").repeat(3);
const routine = (routineId: string, prompt: string) => ({
  routineId,
  name: `Routine ${routineId}`,
  prompt,
  active: true,
  crons: ["0 9 * * 1"],
  timezone: "UTC",
});

describe("a routine list too long for one result", () => {
  it("previews each long prompt with its length and says how to read one", () => {
    const short = routine("short", "Say hi.");
    const listed = fitRoutineList({ routines: [routine("long", longPrompt), short] });
    expect(listed.routines).toEqual([
      {
        ...routine("long", longPrompt.slice(0, 200)),
        promptLength: longPrompt.length,
      },
      short,
    ]);
    expect(listed.note).toContain("routineId");
  });

  it("names every routine when even the previews are too long", () => {
    const routines = Array.from({ length: 60 }, (_, index) => routine(`r${index}`, longPrompt));
    const listed = fitRoutineList({ routines });
    expect(JSON.stringify(listed).length).toBeLessThanOrEqual(10_000);
    expect(listed.routines).toHaveLength(60);
    expect(listed.routines[59]).toEqual({
      routineId: "r59",
      name: "Routine r59",
      active: true,
      promptLength: longPrompt.length,
    });
  });

  it("counts the routines that do not fit even by name", () => {
    const routines = Array.from({ length: 300 }, (_, index) => routine(`r${index}`, longPrompt));
    const listed = fitRoutineList({ routines }) as { routines: unknown[]; notListed: number };
    expect(JSON.stringify(listed).length).toBeLessThanOrEqual(10_000);
    expect(listed.notListed).toBeGreaterThan(0);
    expect(listed.routines.length + listed.notListed).toBe(300);
  });

  it("reads one routine's prompt in full, page by page", () => {
    const list = { routines: [routine("long", longPrompt)] };
    let read = "";
    let offset: number | null = 0;
    while (offset !== null) {
      const page = readRoutine(list, offset) as unknown as {
        routines: [{ prompt: string; promptLength: number; promptNextOffset: number | null }];
      };
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(10_000);
      expect(page.routines[0].promptLength).toBe(longPrompt.length);
      read += page.routines[0].prompt;
      offset = page.routines[0].promptNextOffset;
    }
    expect(read).toBe(longPrompt);
  });
});
