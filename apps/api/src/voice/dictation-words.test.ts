import { expect, it } from "vitest";
import { repositoryNames } from "./dictation-words.js";

it("names repositories from links into them and from owner/name#123, most mentioned first", () => {
  expect(
    repositoryNames([
      "Merged https://example.com/someone/gh-dash/pull/12 and https://example.com/me/rakazo/pull/6",
      "Rebased me/rakazo#7 onto main, see `me/rakazo#8` and [team/scryve#2]",
      "Opened https://code.example/team/scryve/issues/3",
      "CI log: https://example.com/me/rakazo/actions/runs/99",
    ]),
  ).toEqual(["rakazo", "scryve", "gh-dash"]);
});

it("skips ordinary two-part links that are not repository pages", () => {
  expect(
    repositoryNames(["Read https://example.com/blog/release-notes and https://example.com/a/b"]),
  ).toEqual([]);
});
