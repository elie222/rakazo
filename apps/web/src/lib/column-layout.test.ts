import { describe, expect, it } from "vitest";
import { columnsFor } from "./column-layout";

const wide = { sidebarWidth: 280, sidebarRail: false, panelOpen: true, panelWidth: 300 };

describe("columnsFor", () => {
  it("fits all three columns when there is room", () => {
    expect(columnsFor({ viewportWidth: 1280, ...wide })).toEqual({
      sidebarWidth: 280,
      rail: false,
      autoRail: false,
      panelWidth: 300,
      panelFolded: false,
    });
  });

  it("narrows the panel, then folds it before the sidebar gives up any width", () => {
    expect(columnsFor({ viewportWidth: 960, ...wide })).toMatchObject({
      sidebarWidth: 280,
      panelWidth: 280,
    });
    expect(columnsFor({ viewportWidth: 890, ...wide })).toMatchObject({
      sidebarWidth: 280,
      panelWidth: 0,
      panelFolded: true,
    });
  });

  it("then narrows the sidebar to 200px, then puts it on the rail; the thread keeps 400px", () => {
    expect(columnsFor({ viewportWidth: 640, ...wide })).toMatchObject({
      sidebarWidth: 240,
      rail: false,
    });
    for (const viewportWidth of [599, 480]) {
      expect(columnsFor({ viewportWidth, ...wide })).toMatchObject({
        sidebarWidth: 80,
        rail: true,
        autoRail: true,
        panelWidth: 0,
      });
    }
  });

  it("keeps a rail the user chose, and leaves the panel room beside it", () => {
    expect(columnsFor({ viewportWidth: 760, ...wide, sidebarRail: true })).toEqual({
      sidebarWidth: 80,
      rail: true,
      autoRail: false,
      panelWidth: 280,
      panelFolded: false,
    });
  });

  it("gives a closed panel no width and never calls it folded", () => {
    expect(columnsFor({ viewportWidth: 500, ...wide, panelOpen: false })).toMatchObject({
      panelWidth: 0,
      panelFolded: false,
    });
  });

  it("makes room for a panel the user asked for by putting the sidebar on the rail", () => {
    expect(columnsFor({ viewportWidth: 800, ...wide, panelPriority: true })).toEqual({
      sidebarWidth: 80,
      rail: true,
      autoRail: true,
      panelWidth: 300,
      panelFolded: false,
    });
    // Below 700px even the rail leaves no room: the panel stays folded.
    expect(columnsFor({ viewportWidth: 690, ...wide, panelPriority: true })).toMatchObject({
      sidebarWidth: 280,
      panelFolded: true,
    });
  });
});
