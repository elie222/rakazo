export type DemoMessages = Readonly<Record<string, string>>;
export type DemoValues = Record<string, string | number>;

export function fillDemoText(messages: DemoMessages, source: string, values: DemoValues = {}): string {
  const template = messages[source] ?? source;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}
