/** SDK translation fixture; shell allocation and fencing are exercised in core runtime tests. */
export function desktopCommandResponder() {
  const slots = new Map<string, number>();
  return (command: string): { exitCode: number; stdout: string; stderr: string } | undefined => {
    const key = command.match(/slot="\$dir\/([a-f0-9]+)\.slot"/)?.[1];
    if (key && command.includes("RAKAZO_DESKTOP=")) {
      let index = slots.get(key);
      if (index === undefined) {
        index = Array.from({ length: 8 }, (_, candidate) => candidate).find(
          (candidate) => ![...slots.values()].includes(candidate),
        );
        if (index === undefined) return { exitCode: 75, stdout: "", stderr: "full" };
        slots.set(key, index);
      }
      return { exitCode: 0, stdout: `RAKAZO_DESKTOP=${index}:view-${key}\n`, stderr: "" };
    }
    if (key && command.includes("RAKAZO_DESKTOP_RELEASED=")) {
      slots.delete(key);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.includes("base64") && command.includes("CURSOR"))
      return { exitCode: 0, stdout: "AQID\nCURSOR X=10 Y=20\n", stderr: "" };
    return undefined;
  };
}
