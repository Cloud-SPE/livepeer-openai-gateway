// Warn at 400 source lines, error at 600. A ratchet against the long-file
// anti-pattern. Test files and generated code are exempt.

const WARN_AT = 400;
const ERROR_AT = 600;

export default {
  meta: {
    type: 'suggestion',
    docs: { description: 'File size guardrail: warn at 400 lines, error at 600.' },
    schema: [],
    messages: {
      warn: 'File has {{lines}} lines (warning at {{warnAt}}). Consider splitting.',
      error: 'File has {{lines}} lines (error at {{errorAt}}). Split before landing.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    // Skip test fixtures, generated code, and the docs/ bootstrap pdf-ish.
    if (filename.endsWith('.test.ts')) return {};
    if (filename.includes('/gen/')) return {};
    const src = context.sourceCode.getText();
    const lines = src.split(/\r?\n/).length;

    return {
      Program(node) {
        if (lines >= ERROR_AT) {
          context.report({
            node,
            messageId: 'error',
            data: { lines, errorAt: ERROR_AT },
          });
        } else if (lines >= WARN_AT) {
          context.report({ node, messageId: 'warn', data: { lines, warnAt: WARN_AT } });
        }
      },
    };
  },
};
