import { parse } from "yaml";

/** Whether a packaged `app-update.yml` only accepts updates signed by `publisher`. */
export function updateConfigBindsPublisher(config: string, publisher: string): boolean {
  const { publisherName } = (parse(config) ?? {}) as { publisherName?: unknown };
  return (
    publisher !== "" &&
    Array.isArray(publisherName) &&
    publisherName.length === 1 &&
    publisherName[0] === publisher
  );
}
