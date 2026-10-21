// The edition hook. The hosted service replaces this file with its own; the
// default edition allows everything.
import type { ComponentType } from "react";

export type EditionOrganisation = { id: string; slug: string; name: string };

export interface Edition {
  // Whether the organisation may push a private workflow.
  canKeepPrivate(org: EditionOrganisation): Promise<boolean>;
  // Whether the organisation may push at all. Reading stays allowed either way.
  canPush(org: EditionOrganisation): Promise<boolean>;
  // What `/` shows. Without one, `/` is the gallery.
  homePage?: ComponentType;
}

export const edition: Edition = {
  async canKeepPrivate() {
    return true;
  },
  async canPush() {
    return true;
  },
};
