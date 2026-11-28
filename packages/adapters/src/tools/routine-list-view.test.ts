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

  it("continues a list too long even by name until every routine is named", () => {
    const routines = Array.from({ length: 300 }, (_, index) => routine(`r${index}`, longPrompt));
    const ids: string[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = fitRoutineList({ routines }, offset) as {
        routines: { routineId: string }[];
        nextRoutineOffset?: number;
      };
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(10_000);
      ids.push(...page.routines.map((row) => row.routineId));
      offset = page.nextRoutineOffset;
    }
    expect(ids).toEqual(routines.map((row) => row.routineId));
  });

  it("reads a long prompt even when the routine's other details fill the result", () => {
    const watched = { ...routine("watched", longPrompt), watch: { args: "x".repeat(12_000) } };
    const page = readRoutine({ routines: [watched] }, 0) as unknown as {
      routines: [{ prompt: string; promptNextOffset: number }];
    };
    expect(page.routines[0].prompt).toBe(longPrompt.slice(0, page.routines[0].promptNextOffset));
    expect(page.routines[0]).not.toHaveProperty("watch");
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
