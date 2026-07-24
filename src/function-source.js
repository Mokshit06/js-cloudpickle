// Turning `Function.prototype.toString()` output back into an evaluatable
// expression, handling the syntactic forms a function object can carry:
// declarations, expressions, arrows, methods, accessors, generators, classes.

export function isNativeSource(src) {
  return /\{\s*\[native code\]\s*\}\s*$/.test(src);
}

const EXPRESSION_FORM =
  /^(?:async\s+)?function\b|^class\b|^\(|^async\s*\(|^(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/;

/**
 * Wrap raw function source so that `(EXPR)` evaluates to the function.
 * Method shorthand (`foo() {}`, `*gen() {}`, `get x() {}`, `[computed]() {}`,
 * `async foo() {}`) is not a valid expression on its own, so it is re-hosted
 * inside an object literal and extracted through its property descriptor.
 */
export function toExpression(src) {
  const trimmed = src.trim();
  if (EXPRESSION_FORM.test(trimmed)) return trimmed;
  return (
    `((__o__) => { const __d__ = Object.getOwnPropertyDescriptors(__o__); ` +
    `const __k__ = Reflect.ownKeys(__d__)[0]; const __p__ = __d__[__k__]; ` +
    `return __p__.get ?? __p__.set ?? __p__.value; })({ ${trimmed} })`
  );
}

export const SUPER_BINDING = '__cpjs_super__';

/**
 * Replace a class source's `extends <expr>` heritage clause with a synthetic
 * `extends __cpjs_super__` identifier. The parent class is pickled separately
 * (V8 stores the heritage in an internal slot, not in `[[Scopes]]`), so the
 * original extends expression must not be re-evaluated at load time.
 * Returns the source unchanged when there is no heritage clause.
 */
export function rewriteHeritage(src) {
  const m = /^(class(?:\s+[A-Za-z_$][\w$]*)?)\s+extends\b/.exec(src);
  if (!m) return src;
  // Scan the heritage expression up to the top-level `{` that opens the body.
  let i = m[0].length;
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === '{') {
      if (depth === 0) break;
      depth++;
    } else if (ch === '}') depth--;
    else if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      for (i++; i < src.length && src[i] !== quote; i++) {
        if (src[i] === '\\') i++;
      }
    }
  }
  return `${m[1]} extends ${SUPER_BINDING} ${src.slice(i)}`;
}

const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
  'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await',
]);

export function isBindableName(name) {
  return /^[A-Za-z_$][\w$]*$/.test(name) && !RESERVED.has(name);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `name` plausibly appears as an identifier in `src`. Used to prune
 * context-allocated variables that belong to sibling closures. When the
 * source contains `eval`, everything is kept.
 */
export function sourceReferences(src, name) {
  if (/\beval\b/.test(src)) return true;
  // Reject property accesses (`obj.name`, `obj?.name`) but not spread/rest
  // (`...name`, where the preceding `.` is itself preceded by a `.`).
  return new RegExp(`(?<![\\w$])(?<!(?<!\\.)\\.)${escapeRegExp(name)}(?![\\w$])`).test(src);
}
