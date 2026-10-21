// The registry's own lint rules.
import accessChecked from "./access-checked.mjs";
import noBilling from "./no-billing.mjs";

export default {
  meta: { name: "awml-registry" },
  rules: { "access-checked": accessChecked, "no-billing": noBilling },
};
