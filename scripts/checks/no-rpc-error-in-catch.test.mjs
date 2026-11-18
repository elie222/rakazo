import assert from "node:assert/strict";
import { test } from "node:test";
import { count } from "./ratchets/no-rpc-error-in-catch.mjs";

const lines = (text) => count(text).map((hit) => hit.line);

test("counts a throw in a catch block, with or without a binding", () => {
  const text = `try {
  await save();
} catch (error) {
  throw new ORPCError("BAD_REQUEST", { message: String(error) });
}
try {
  decode(bytes);
} catch {
  throw new ORPCError("BAD_REQUEST");
}`;
  assert.deepEqual(count(text), [
    { line: 4, text: 'throw new ORPCError("BAD_REQUEST", { message: String(error) });' },
    { line: 9, text: 'throw new ORPCError("BAD_REQUEST");' },
  ]);
});

test("ignores a throw in the try block, in finally, and after the handler ends", () => {
  const text = `try {
  if (!row) throw new ORPCError("NOT_FOUND");
} catch (error) {
  log(error);
  throw error;
} finally {
  if (stale) throw new ORPCError("CONFLICT");
}
throw new ORPCError("BAD_REQUEST");`;
  assert.deepEqual(lines(text), []);
});

test("counts a throw in a function nested in a handler, not in one that only contains a handler", () => {
  const text = `function outer() {
  try {
    run();
  } catch (error) {
    const refuse = () => {
      throw new ORPCError("CONFLICT");
    };
    refuse();
  }
  return () => {
    throw new ORPCError("FORBIDDEN");
  };
}`;
  assert.deepEqual(lines(text), [6]);
});

test("counts a throw in a .catch() callback, and nothing after the call closes", () => {
  const text = `const row = await create().catch((error: unknown) => {
  if (isUniqueViolation(error)) throw new ORPCError("CONFLICT");
  throw error;
});
await cleanup().catch(() => undefined);
if (!row) throw new ORPCError("NOT_FOUND");`;
  assert.deepEqual(lines(text), [2]);
});

test("is not misled by braces and the word catch in strings, comments, templates and regexes", () => {
  const text = `const hint = "} catch (error) {";
// } catch {
/* catch { */
const label = \`catch { \${names.map((name) => \`{\${name}}\`).join(", ")}\`;
const braces = /[{}]|catch \\{/.test(hint);
throw new ORPCError("BAD_REQUEST", { message: label });
try {
  run(\`\${a} }\`, "{", '}');
} catch (error) {
  const half = total / 2; // not a regex
  throw new ORPCError("CONFLICT", { message: \`\${half} }\` });
}
throw new ORPCError("NOT_FOUND");`;
  assert.deepEqual(lines(text), [11]);
});

test("ignores other errors and names that only start the same", () => {
  const text = `try {
  run();
} catch (error) {
  throw new ORPCErrorish("x");
  throw new Error("y", { cause: error });
  return ORPCError;
}`;
  assert.deepEqual(lines(text), []);
});

test("counts a throw in a catch whose clause holds comments", () => {
  const text = `try {
  run();
} catch /* why */ (error) /* still why */ {
  throw new ORPCError("BAD_REQUEST");
}
try {
  run();
} catch // none
{
  throw new ORPCError("CONFLICT");
}`;
  assert.deepEqual(lines(text), [4, 10]);
});

test("reads a regex after an arrow as a regex, so a bracket in it closes nothing", () => {
  const text = `try {
  run();
} catch {
  const closes = (s) => /\\)/.test(s);
  throw new ORPCError("BAD_REQUEST");
}`;
  assert.deepEqual(lines(text), [5]);
});

test("counts a throw in a .catch() callback that has a type argument", () => {
  const text = `const row = await create().catch<unknown>((error) => {
  throw new ORPCError("CONFLICT");
});`;
  assert.deepEqual(lines(text), [2]);
});
