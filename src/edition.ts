// The edition hook. The hosted service replaces this file with its own; the
// default edition allows everything.
import type { ComponentType } from "react";

export type EditionOrganisation = { id: string; slug: string; name: string };

export type EditionUser = { id: string; username: string };

export interface Edition {
  // Whether the organisation may push a private workflow.
  canKeepPrivate(org: EditionOrganisation): Promise<boolean>;
  // Whether the organisation may push at all. Reading stays allowed either way.
  canPush(org: EditionOrganisation): Promise<boolean>;
  // How many private workflows a user may keep on their own account, or null
  // for no limit.
  privateWorkflowLimit(user: EditionUser): Promise<number | null>;
  // What `/` shows. Without one, `/` is the gallery.
  homePage?: ComponentType;
  // Where the terms and privacy policy are, for the sign-in page to link to.
  // Without them, the sign-in page names neither.
  legalLinks?: { terms: string; privacy: string };
}

export const edition: Edition = {
  async canKeepPrivate() {
    return true;
  },
  async canPush() {
    return true;
  },
  async privateWorkflowLimit() {
    return null;
  },
};
