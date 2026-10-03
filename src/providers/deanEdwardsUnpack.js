'use strict';

/**
 * deanEdwardsUnpack.js — safe unpacker for the Dean Edwards "packer" scheme.
 *
 * The classic packer emits:
 *
 *   eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\b'+
 *     c.toString(a)+'\\b','g'),k[c]);return p}('PAYLOAD',36,533,'w0|w1|...'.split('|')))
 *
 * Historically this codebase ran the body through `eval()`. That executes
 * arbitrary JavaScript fetched from a third-party host inside the Node process,
 * which is a remote-code-execution surface. This module reproduces the exact
 * substitution the packer performs, using only string operations — it never
 * evaluates the fetched code.
 *
 * `unpack()` returns the decoded string, or null for anything malformed. It
 * never throws.
 */

/** Reads a single- or double-quoted JS string literal starting at `start`. */
function scanStringLiteral(src, start) {
  const quote = src[start];
  let i = start + 1;
  let out = '';
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      const next = src[i + 1];
      switch (next) {
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        case '0': out += '\0'; break;
        case '\\': out += '\\'; break;
        case "'": out += "'"; break;
        case '"': out += '"'; break;
        case '\n': break; // line continuation
        case '\r': break;
        case 'x': {
          const hex = src.slice(i + 2, i + 4);
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            continue;
          }
          out += next;
          break;
        }
        case 'u': {
          const hex = src.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 6;
            continue;
          }
          out += next;
          break;
        }
        default: out += next;
      }
      i += 2;
      continue;
    }
    if (ch === quote) return { value: out, end: i + 1 };
    out += ch;
    i += 1;
  }
  return null;
}

/**
 * Finds the index of the bracket that closes the one at `start`, skipping over
 * string literals and nested brackets of the same kind.
 */
function findMatchingBracket(src, start, open, close) {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      const lit = scanStringLiteral(src, i);
      if (!lit) return -1;
      i = lit.end;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** Splits an argument list on top-level commas, ignoring nested brackets. */
function splitTopLevel(src) {
  const parts = [];
  let depth = 0;
  let current = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"') {
      const lit = scanStringLiteral(src, i);
      if (!lit) return null;
      current += src.slice(i, lit.end);
      i = lit.end;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  parts.push(current);
  return parts;
}

/** Interprets one packer argument: number, string literal, or split(...) call. */
function interpretArg(raw) {
  const arg = raw.trim();
  if (!arg) return undefined;

  if (/^-?\d+$/.test(arg)) return Number(arg);

  if (arg[0] === "'" || arg[0] === '"') {
    const lit = scanStringLiteral(arg, 0);
    if (!lit) return undefined;
    const rest = arg.slice(lit.end).trim();
    if (!rest) return lit.value;

    // e.g. 'w0|w1|w2'.split('|')
    const splitCall = rest.match(/^\.split\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*\)$/);
    if (splitCall) {
      let sep = splitCall[2];
      if (splitCall[1] === "'") sep = sep.replace(/\\'/g, "'");
      sep = sep.replace(/\\\\/g, '\\');
      return lit.value.split(sep);
    }
    return undefined;
  }

  return undefined;
}

/**
 * Decodes a Dean Edwards packed `function(...){...}(...)` expression.
 * Accepts an optional leading `eval(` wrapper or surrounding parentheses.
 * Returns the decoded string, or null when the input is not a valid packer body.
 */
function unpack(input) {
  if (typeof input !== 'string') return null;
  let src = input.trim();
  if (!src) return null;

  // Tolerate an `eval(...)` wrapper / redundant parentheses.
  if (src.startsWith('eval')) src = src.slice(4).trim();
  while (src.startsWith('(') && findMatchingBracket(src, 0, '(', ')') === src.length - 1) {
    src = src.slice(1, -1).trim();
  }

  if (!/^function\b/.test(src)) return null;

  const paramsStart = src.indexOf('(');
  if (paramsStart === -1) return null;
  const paramsEnd = findMatchingBracket(src, paramsStart, '(', ')');
  if (paramsEnd === -1) return null;

  const bodyStart = src.indexOf('{', paramsEnd);
  if (bodyStart === -1) return null;
  const bodyEnd = findMatchingBracket(src, bodyStart, '{', '}');
  if (bodyEnd === -1) return null;

  // The invocation arguments follow the function body.
  const callStart = src.indexOf('(', bodyEnd);
  if (callStart === -1) return null;
  const callEnd = findMatchingBracket(src, callStart, '(', ')');
  if (callEnd === -1) return null;
  if (src.slice(bodyEnd + 1, callStart).trim() !== '') return null;

  const rawArgs = splitTopLevel(src.slice(callStart + 1, callEnd));
  if (!rawArgs || rawArgs.length < 3) return null;

  // Resolve by shape rather than by parameter name, so renamed params still work.
  let payload = undefined;
  let radix = undefined;
  let count = undefined;
  let words = undefined;

  for (const raw of rawArgs) {
    const value = interpretArg(raw);
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (words === undefined) words = value;
    } else if (typeof value === 'number') {
      if (radix === undefined) radix = value;
      else if (count === undefined) count = value;
    } else if (typeof value === 'string') {
      if (payload === undefined) payload = value;
    }
  }

  if (payload === undefined || radix === undefined || count === undefined || words === undefined) {
    return null;
  }
  if (!Number.isInteger(radix) || radix < 2 || radix > 36) return null;
  if (!Number.isInteger(count) || count < 0) return null;

  // Single-pass dictionary substitution: O(1) per token rather than O(N) regex compilation passes
  const dict = new Map();
  for (let c = count - 1; c >= 0; c -= 1) {
    const word = words[c];
    if (word) {
      dict.set(c.toString(radix), word);
    }
  }
  return payload.replace(/\b\w+\b/g, (token) => dict.get(token) || token);
}

module.exports = { unpack };
