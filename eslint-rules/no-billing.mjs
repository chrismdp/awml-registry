// This repo is the open, self-hostable registry. Billing lives in the private
// hosted repo, which plugs in by replacing src/edition.ts, so nothing here,
// that file included, may mention it.

const WORDS = /stripe|billing|subscription|invoice|checkout/gi;

export default {
  meta: {
    type: "problem",
    docs: { description: "The open repo never contains billing" },
    schema: [],
    messages: {
      billing:
        '"{{word}}": billing belongs in the private hosted repo, which adds it through src/edition.ts. This open repo must not mention it in code, strings or comments.',
    },
  },
  create(context) {
    return {
      Program(node) {
        const { text } = context.sourceCode;
        for (const match of text.matchAll(WORDS)) {
          const start = context.sourceCode.getLocFromIndex(match.index);
          const end = context.sourceCode.getLocFromIndex(match.index + match[0].length);
          context.report({ node, loc: { start, end }, messageId: "billing", data: { word: match[0] } });
        }
      },
    };
  },
};
