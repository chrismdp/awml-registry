// Following a linked part (#55) or a workflow's box on a system's map (#61) as a link would be
// followed: where it goes, in which tab, by which key, and a drag that follows nothing; and on a
// touch screen, which has no hover, a tap that lights a part as hovering does and a second tap
// that follows it (src/components/links.ts). The drawing's nodes that carry these are in
// test/flow-canvas.test.tsx, and what a lit part looks like in test/flow-hover.test.tsx.
import { describe, expect, it } from "vitest";
import { destination, DRAG, followOf, followsOnKey, Gesture, newTab, Press, tapOf } from "@/components/links";

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

  it("always opens a new tab in a drawing embedded on another site (#75), never the frame", () => {
    expect(followOf("/acme/shopping#list", plain, false, true)).toEqual({ to: "/acme/shopping#list", newTab: true });
    expect(followOf("menu", plain, false, true)).toBe("menu");
    expect(followOf(null, plain, false, true)).toBeNull();
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

// A tap, on a touch screen or with a pen: `tapOf(tapped, on, follows, touch)`, where `tapped` is
// what the last tap lit, `on` the part or box pressed (none for the background or a line),
// `follows` whether a click on it follows a link, and `touch` whether it was a touch or a pen.
describe("a tap on a part, on a touch screen", () => {
  it("lights the part, and doesn't follow its link", () => {
    expect(tapOf(undefined, "list", true, true)).toEqual({ lit: "list", follow: false });
  });

  it("follows the part's link when it is tapped again, and keeps it lit", () => {
    expect(tapOf("list", "list", true, true)).toEqual({ lit: "list", follow: true });
  });

  it("keeps a part that leads nowhere lit when it is tapped again, and follows nothing", () => {
    expect(tapOf("plan", "plan", false, true)).toEqual({ lit: "plan", follow: false });
  });

  it("moves the light to another part tapped, which it doesn't follow", () => {
    expect(tapOf("plan", "list", true, true)).toEqual({ lit: "list", follow: false });
  });

  it("puts the light out on a tap on the background or a line", () => {
    expect(tapOf("list", undefined, false, true)).toEqual({ lit: undefined, follow: false });
  });

  it("takes a box that leads somewhere, a workflow's on a map, the same way: a first tap follows nothing, a second does", () => {
    expect(tapOf("plan", "w1", true, true)).toEqual({ lit: "w1", follow: false });
    expect(tapOf("w1", "w1", true, true)).toEqual({ lit: "w1", follow: true });
  });
});

describe("a mouse's click on a part", () => {
  it("follows its link at once, and leaves what a tap lit as it was", () => {
    expect(tapOf(undefined, "list", true, false)).toEqual({ lit: undefined, follow: true });
    expect(tapOf("plan", "list", true, false)).toEqual({ lit: "plan", follow: true });
    expect(tapOf("plan", "plan", false, false)).toEqual({ lit: "plan", follow: false });
    expect(tapOf("plan", undefined, false, false)).toEqual({ lit: "plan", follow: false });
  });
});

// The pointer's events of a press, as the drawing's frame sees them.
const finger = (pointerId: number, clientX: number, clientY: number, isPrimary = true) => ({ pointerId, pointerType: "touch", isPrimary, clientX, clientY });

describe("what a press was, when the click that ends it comes", () => {
  it("is a tap: one finger, lifted where it went down", () => {
    const g = new Gesture();
    g.down(finger(1, 100, 100));
    g.move(finger(1, 101, 99));
    expect(g.ended()).toEqual({ touch: true, tap: true });
  });

  it("is a tap with a pen too", () => {
    const g = new Gesture();
    g.down({ ...finger(1, 100, 100), pointerType: "pen" });
    expect(g.ended()).toEqual({ touch: true, tap: true });
  });

  it("is a tap while the finger moves no further than the distance that starts a part's drag", () => {
    const g = new Gesture();
    g.down(finger(1, 100, 100));
    g.move(finger(1, 100 + DRAG, 100));
    expect(g.ended()).toEqual({ touch: true, tap: true });
  });

  it("is no tap once the finger moves further than that, as a drag or a pan does, even back where it started", () => {
    const g = new Gesture();
    g.down(finger(1, 100, 100));
    g.move(finger(1, 100, 100 + DRAG + 1));
    g.move(finger(1, 100, 100));
    expect(g.ended()).toEqual({ touch: true, tap: false });
  });

  it("is no tap when a second finger goes down, as in a pinch", () => {
    const g = new Gesture();
    g.down(finger(1, 100, 100));
    g.down(finger(2, 200, 200, false));
    expect(g.ended()).toEqual({ touch: true, tap: false });
  });

  it("is no tap when the browser takes the press over", () => {
    const g = new Gesture();
    g.down(finger(1, 100, 100));
    g.cancel();
    expect(g.ended()).toEqual({ touch: true, tap: false });
  });

  it("is a mouse's, not a touch's, for a mouse", () => {
    const g = new Gesture();
    g.down({ ...finger(1, 100, 100), pointerType: "mouse" });
    expect(g.ended()).toEqual({ touch: false, tap: true });
  });

  it("is taken as a mouse's for a click no pointer pressed, such as a screen reader's, and forgotten once asked", () => {
    const g = new Gesture();
    expect(g.ended()).toEqual({ touch: false, tap: true });
    g.down(finger(1, 100, 100));
    g.ended();
    expect(g.ended()).toEqual({ touch: false, tap: true });
  });

  it("starts afresh with the next finger down", () => {
    const g = new Gesture();
    g.down(finger(1, 100, 100));
    g.move(finger(1, 300, 300));
    g.ended();
    g.down(finger(2, 50, 50));
    expect(g.ended()).toEqual({ touch: true, tap: true });
  });
});
