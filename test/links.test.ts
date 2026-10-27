// Following a linked part (#55) or a workflow's box on a system's map (#61) as a link would be
// followed: where it goes, in which tab, by which key, and a drag that follows nothing
// (src/components/links.ts). The drawing's nodes that carry these are in test/flow-canvas.test.tsx.
import { describe, expect, it } from "vitest";
import { destination, followOf, followsOnKey, newTab, Press } from "@/components/links";

const plain = { button: 0, ctrlKey: false, metaKey: false };
const one = { part: "list", title: "Linked to acme/shopping#list", to: [{ label: "acme/shopping", href: "/acme/shopping#list" }] };
const several = {
  part: "list",
  title: "Used by a/b and c/d",
  to: [
    { label: "a/b", href: "/a/b" },
    { label: "c/d", href: "/c/d" },
  ],
};
const hidden = { part: "list", title: "Linked to a workflow you can't see", to: [] };

describe("where a linked part goes", () => {
  it("goes straight to its one workflow, gives a menu of several, and goes nowhere it may not", () => {
    expect(destination(one)).toBe("/acme/shopping#list");
    expect(destination(several)).toBe("menu");
    expect(destination(hidden)).toBeNull();
  });
});

describe("following a part", () => {
  it("opens its workflow here, or in a new tab with Ctrl or ⌘ held, or the middle button", () => {
    expect(followOf("/acme/shopping#list", plain, false)).toEqual({ to: "/acme/shopping#list", newTab: false });
    expect(followOf("/acme/shopping#list", { ...plain, ctrlKey: true }, false)).toEqual({ to: "/acme/shopping#list", newTab: true });
    expect(newTab({ button: 0, ctrlKey: true, metaKey: false })).toBe(true);
    expect(newTab({ button: 0, ctrlKey: false, metaKey: true })).toBe(true);
    expect(newTab({ button: 1, ctrlKey: false, metaKey: false })).toBe(true);
    expect(newTab(plain)).toBe(false);
    // A key has no button.
    expect(newTab({ ctrlKey: false, metaKey: false })).toBe(false);
  });

  it("opens the menu of a part with several places to go, a new tab of it still the menu, and closes it when open", () => {
    expect(followOf("menu", plain, false)).toBe("menu");
    expect(followOf("menu", { ...plain, metaKey: true }, false)).toBe("menu");
    expect(followOf("menu", plain, true)).toBe("close");
  });

  it("does nothing on a part that leads nowhere", () => {
    expect(followOf(destination(hidden), plain, false)).toBeNull();
  });
});

describe("a key on a part", () => {
  it("follows a link on Enter, and opens a menu on Enter or Space", () => {
    expect(followsOnKey("Enter", "link")).toBe(true);
    expect(followsOnKey(" ", "link")).toBe(false);
    expect(followsOnKey("Enter", "button")).toBe(true);
    expect(followsOnKey(" ", "button")).toBe(true);
    expect(followsOnKey("a", "button")).toBe(false);
  });
});

describe("a press on a part", () => {
  it("follows the part when the click ends a press that didn't drag it", () => {
    const press = new Press();
    expect(press.followsClick()).toBe(true);
  });

  it("follows nothing when the click ends a drag, and the next press starts afresh", () => {
    const press = new Press();
    press.reset();
    press.moved();
    expect(press.followsClick()).toBe(false);
    expect(press.followsClick()).toBe(true);
  });

  it("starts afresh after a drag that ended with no click on the part", () => {
    const press = new Press();
    press.moved();
    press.reset();
    expect(press.followsClick()).toBe(true);
  });
});
