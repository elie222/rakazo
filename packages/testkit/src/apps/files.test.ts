import { describe, expect, it } from "vitest";
import { fileId } from "./files.js";
import { studioFacts, studioFiles } from "./fixtures/studio.js";

const now = new Date("2026-11-06T16:30:00Z");
const ok = (result: ReturnType<ReturnType<typeof studioFiles>["call"]>) => {
  if (!result.ok) throw new Error(result.error.message);
  return result.data as Record<string, any>;
};

describe("files emulator", () => {
  it("searches names and contents, ranking name matches and newest first", () => {
    const files = studioFiles({ now });
    const juniper = ok(files.call("search_files", { query: "juniper proposal" }));
    expect(juniper.files.map((f: { name: string }) => f.name)).toEqual([
      "Juniper Row – Lobby Proposal v3",
      "Juniper Row – Lobby Proposal v2",
    ]);
    expect(juniper.files[0]).toMatchObject({
      path: "/My files/Clients/Juniper Row Hotel",
      web_url: studioFacts(now).proposalV3Url,
      last_modified_by: "leo@haldenmoss.example",
    });
    expect(
      ok(files.call("search_files", { query: "walnut", type: "document" })).files,
    ).toHaveLength(1);
    expect(ok(files.call("search_files", { query: '"payment terms"' })).files[0].type).toBe("pdf");
    // A file the account cannot open never appears in search.
    expect(ok(files.call("search_files", { query: "FY2027" })).files).toEqual([]);
  });

  it("lists folders with pagination", () => {
    const files = studioFiles({ now });
    const root = ok(files.call("list_folder", { page_size: 3 }));
    expect(root.files.map((f: { name: string }) => f.name)).toEqual([
      "Brand",
      "Clients",
      "Finance",
    ]);
    const rest = ok(files.call("list_folder", { page_size: 3, page_token: root.next_page_token }));
    expect(rest.files.map((f: { name: string }) => f.name)).toEqual([
      "Suppliers",
      "Templates",
      "Meeting notes – October 2026",
    ]);
    expect(rest.next_page_token).toBeNull();
  });

  it("reads documents and sheets by id or link, and reports sharing", () => {
    const files = studioFiles({ now });
    const v3 = ok(files.call("read_file", { file_id: studioFacts(now).proposalV3Url }));
    expect(v3.content).toContain("**41,250**");
    const sheet = ok(files.call("read_file", { file_id: fileId("budget-2026"), sheet: "Summary" }));
    expect(sheet.sheets[0].rows).toContainEqual(["Marketing", "64,000"]);
    const meta = ok(files.call("get_file_metadata", { file_id: fileId("juniper-proposal-v2") }));
    expect(meta.permissions).toContainEqual({
      email: "dana.whitfield@juniperrow.example",
      role: "commenter",
    });
    expect(meta.capabilities).toEqual({ can_edit: true, can_comment: true, can_share: true });
  });

  it("refuses files the account cannot open or edit", () => {
    const files = studioFiles({ now });
    const denied = files.call("read_file", { file_id: studioFacts(now).budget2027Id });
    expect(denied.ok ? null : denied.error).toMatchObject({
      code: "permission_denied",
      status: 403,
    });
    expect(denied.ok ? "" : denied.error.message).toContain("marta@haldenmoss.example");
    const readOnly = files.call("share_file", {
      file_id: fileId("budget-2026"),
      email: "a@b.example",
      role: "reader",
    });
    expect(readOnly.ok ? null : readOnly.error.code).toBe("permission_denied");
    const missing = files.call("get_file_metadata", { file_id: "1doesnotexist" });
    expect(missing.ok ? null : missing.error.code).toBe("not_found");
    expect(files.writes).toEqual([]);
  });

  it("records writes with before and after", () => {
    const files = studioFiles({ now });
    const created = ok(
      files.call("create_document", {
        name: "Juniper follow-up",
        folder_id: fileId("juniper"),
        content: "Call Dana",
      }),
    );
    expect(created.path).toBe("/My files/Clients/Juniper Row Hotel");
    ok(files.call("update_document", { file_id: created.id, content: "Sent v3", mode: "append" }));
    ok(
      files.call("append_sheet_rows", {
        file_id: fileId("invoices-2026"),
        sheet: "Issued",
        rows: [["HM-2026-043", "Juniper Row Hotel", "16,500", "Due"]],
      }),
    );
    ok(
      files.call("share_file", {
        file_id: fileId("juniper-proposal-v3"),
        email: "dana.whitfield@juniperrow.example",
        role: "commenter",
      }),
    );
    expect(files.writes.map((w) => w.tool)).toEqual([
      "create_document",
      "update_document",
      "append_sheet_rows",
      "share_file",
    ]);
    expect(files.writesTo("update_document")[0]).toMatchObject({
      before: "Call Dana",
      after: "Call Dana\nSent v3",
    });
    expect(ok(files.call("search_files", { query: "follow-up" })).files[0].id).toBe(created.id);
  });
});
