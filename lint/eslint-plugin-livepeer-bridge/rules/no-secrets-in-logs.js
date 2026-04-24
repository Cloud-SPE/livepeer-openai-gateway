// Scans log-call arguments for identifiers / object-keys that match a
// denylist of secret-bearing names. Catches the classic "accidentally logged
// the API key" footgun.
//
// Log calls considered: console.log/warn/error/info/debug, req.log.<level>,
// logger.<level>, reply.log.<level>.

const SECRET_PATTERNS = [
  /^api[_-]?key$/i,
  /^stripe[_-]?secret/i,
  /^stripe[_-]?webhook[_-]?secret/i,
  /^stripe[_-]?signing[_-]?secret/i,
  /^webhook[_-]?secret/i,
  /^passphrase$/i,
  /^private[_-]?key$/i,
  /^keystore$/i,
  /^admin[_-]?token$/i,
  /^api[_-]?key[_-]?pepper$/i,
  /^pepper$/i,
  /^bearer$/i,
];

function isSecretName(name) {
  return SECRET_PATTERNS.some((r) => r.test(name));
}

function isLogCall(node) {
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (callee.type !== 'MemberExpression') return false;
  if (callee.property.type !== 'Identifier') return false;
  const method = callee.property.name;
  if (!['log', 'warn', 'error', 'info', 'debug', 'trace'].includes(method)) return false;
  // Walk back through the member chain; accept console, logger, req.log, reply.log, etc.
  let obj = callee.object;
  while (obj && obj.type === 'MemberExpression') obj = obj.object;
  if (obj && obj.type === 'Identifier') {
    const name = obj.name;
    return name === 'console' || name === 'logger' || name === 'req' || name === 'reply';
  }
  return false;
}

function checkExpression(expr, context) {
  if (!expr) return;
  if (expr.type === 'Identifier') {
    if (isSecretName(expr.name)) {
      context.report({ node: expr, messageId: 'identifier', data: { name: expr.name } });
    }
    return;
  }
  if (expr.type === 'ObjectExpression') {
    for (const prop of expr.properties) {
      if (prop.type !== 'Property') continue;
      const keyName =
        prop.key.type === 'Identifier'
          ? prop.key.name
          : prop.key.type === 'Literal' && typeof prop.key.value === 'string'
            ? prop.key.value
            : null;
      if (keyName && isSecretName(keyName)) {
        context.report({ node: prop.key, messageId: 'key', data: { name: keyName } });
      }
      checkExpression(prop.value, context);
    }
    return;
  }
  if (expr.type === 'MemberExpression') {
    if (expr.property.type === 'Identifier' && isSecretName(expr.property.name)) {
      context.report({
        node: expr.property,
        messageId: 'identifier',
        data: { name: expr.property.name },
      });
    }
  }
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Reject passing known-secret names or object keys to log calls (console, logger, req.log, reply.log).',
    },
    schema: [],
    messages: {
      identifier:
        'Do not pass `{{name}}` to a log call — this looks like a secret. Redact or omit.',
      key: 'Object key `{{name}}` looks like a secret; do not log it. Redact or omit.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isLogCall(node)) return;
        for (const arg of node.arguments) checkExpression(arg, context);
      },
    };
  },
};
