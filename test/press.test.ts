// What a press on a workflow's drawing does when it lifts: a press on a
// marked part that didn't move follows it, as a link would, and one that
// moved or that a second finger joined only moved the drawing. The frame
// that holds the drawing is in test/panzoom.test.tsx.
import { describe, expect, it } from "vitest";
import { follow, followsOnKey, lifted, moved, newTab, pressed, secondPointer, TAP_SLOP_PX, type Press } from "@/components/press";

const at = { x: 100, y: 100 };
const plain = { newTab: false, menuOpen: false };
const onLink = (asked = plain): Press => pressed(at, "mouse", "/acme/shopping#list", asked);

describe("a press on the drawing", () => {
  it("follows a marked part when it lifts without moving", () => {
    expect(lifted(onLink())).toEqual({ to: "/acme/shopping#list", newTab: false });
    // A finger's jitter, within the tap slop, is still a tap.
    expect(TAP_SLOP_PX).toBe(8);
    expect(lifted(moved(onLink(), { x: 106, y: 105 }))).toEqual({ to: "/acme/shopping#list", newTab: false });
  });

  it("does nothing more after a drag further than the tap slop, even back to where it started", () => {
    const dragged = moved(onLink(), { x: 100 + TAP_SLOP_PX + 1, y: 100 });
    expect(dragged.dragged).toBe(true);
    expect(lifted(dragged)).toBeNull();
    expect(lifted(moved(dragged, at))).toBeNull();
  });

  it("is a drag once a second finger joins it", () => {
    const pinching = secondPointer(pressed(at, "touch", "/acme/shopping#list", plain));
    expect(lifted(pinching)).toBeNull();
  });

  it("opens the part's workflow in a new tab with Ctrl or ⌘ held, or the middle button", () => {
    expect(newTab({ button: 0, ctrlKey: true, metaKey: false })).toBe(true);
    expect(newTab({ button: 0, ctrlKey: false, metaKey: true })).toBe(true);
    expect(newTab({ button: 1, ctrlKey: false, metaKey: false })).toBe(true);
    expect(newTab({ button: 0, ctrlKey: false, metaKey: false })).toBe(false);
    // A key has no button.
    expect(newTab({ ctrlKey: false, metaKey: false })).toBe(false);
    expect(lifted(onLink({ newTab: true, menuOpen: false }))).toEqual({ to: "/acme/shopping#list", newTab: true });
  });

  it("opens the menu of a part with several places to go, and closes it when it is open", () => {
    expect(lifted(pressed(at, "mouse", "menu", plain))).toBe("menu");
    // A new tab of a menu is still the menu, whose links open where they're asked to.
    expect(lifted(pressed(at, "mouse", "menu", { newTab: true, menuOpen: false }))).toBe("menu");
    expect(lifted(pressed(at, "touch", "menu", { newTab: false, menuOpen: true }))).toBe("close");
  });

  it("does nothing on a part that leads nowhere, on nothing marked, or when the press is cancelled", () => {
    expect(lifted(pressed(at, "mouse", null, plain))).toBeNull();
    expect(lifted(undefined)).toBeNull();
    expect(lifted(onLink(), true)).toBeNull();
  });
});

describe("a key on a marked part", () => {
  it("follows a link on Enter, and opens a menu on Enter or Space", () => {
    expect(followsOnKey("Enter", "link")).toBe(true);
    expect(followsOnKey(" ", "link")).toBe(false);
    expect(followsOnKey("Enter", "button")).toBe(true);
    expect(followsOnKey(" ", "button")).toBe(true);
    expect(followsOnKey("a", "button")).toBe(false);
    expect(follow("menu", plain)).toBe("menu");
    expect(follow("/acme/dinners", { newTab: true, menuOpen: false })).toEqual({ to: "/acme/dinners", newTab: true });
    expect(follow("menu", { newTab: false, menuOpen: true })).toBe("close");
  });
});
