const target = {
  role: {
    type: "string",
    description: "ARIA role from the snapshot, such as button, link, textbox",
  },
  name: { type: "string", description: "Accessible name from the snapshot" },
};

function tool(name, description, properties = {}, required = []) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false },
    },
  };
}

export const exploreTools = [
  tool("goto", "Open a path in the app, such as / or /settings.", { path: { type: "string" } }, [
    "path",
  ]),
  tool("snapshot", "Read the current page as an accessibility tree."),
  tool("click", "Click the element with this role and accessible name.", target, ["role", "name"]),
  tool(
    "fill",
    "Replace the text in the field with this role and accessible name.",
    { ...target, value: { type: "string" } },
    ["role", "name", "value"],
  ),
  tool("press", "Press a key, such as Enter, Escape or Tab.", { key: { type: "string" } }, ["key"]),
  tool("screenshot", "Save a screenshot of the page and return its file name."),
  tool(
    "report_bug",
    "Report one bug you saw.",
    {
      title: { type: "string", description: "One line naming the problem" },
      key: { type: "string", description: "Short kebab-case name of the bug" },
      path: { type: "string", description: "Path of the page where it happens" },
      steps: { type: "array", items: { type: "string" } },
      expected: { type: "string" },
      actual: { type: "string" },
      screenshot: {
        type: "string",
        description: "File name returned by screenshot that shows the bug",
      },
    },
    ["title", "key", "path", "steps", "expected", "actual", "screenshot"],
  ),
  tool("finish", "Stop exploring this feature.", { summary: { type: "string" } }, ["summary"]),
];
