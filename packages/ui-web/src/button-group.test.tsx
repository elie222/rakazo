import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./components/ui/button.js";
import { ButtonGroup } from "./components/ui/button-group.js";
import { InputGroup, InputGroupInput } from "./components/ui/input-group.js";

describe("text button", () => {
  it("sits flush with the text around it, also next to an icon", () => {
    const html = renderToString(
      <Button variant="text">
        <span data-icon="inline-start" />
        Back
      </Button>,
    );
    const classes = html.match(/<button[^>]*class="([^"]*)"/)?.[1]?.split(" ") ?? [];

    expect(classes).toContain("px-0");
    expect(classes).toContain("has-data-[icon=inline-start]:pl-0");
    expect(classes).not.toContain("has-data-[icon=inline-start]:pl-2");
  });
});

describe("ButtonGroup", () => {
  it("keeps the error colour on a focused field that is invalid", () => {
    const html = renderToString(
      <ButtonGroup>
        <input aria-invalid />
        <Button>Search</Button>
      </ButtonGroup>,
    );
    const classes =
      html
        .match(/<div[^>]*class="([^"]*)"/)?.[1]
        ?.replaceAll("&amp;", "&")
        .split(" ") ?? [];

    expect(classes).toContain("[&_input[aria-invalid=true]]:focus-visible:border-destructive");
    expect(classes).toContain("has-[input[aria-invalid=true]:focus-visible]:ring-destructive/20");
  });
});

describe("InputGroup", () => {
  it("grows with an xl field, so its border and ring surround it", () => {
    const html = renderToString(
      <InputGroup>
        <InputGroupInput size="xl" />
      </InputGroup>,
    );
    const classes =
      html
        .match(/<div[^>]*class="([^"]*)"/)?.[1]
        ?.replaceAll("&amp;", "&")
        .split(" ") ?? [];

    expect(html).toContain('data-size="xl"');
    expect(classes).toContain("has-[[data-slot=input-group-control][data-size=xl]]:h-12");
  });
});
