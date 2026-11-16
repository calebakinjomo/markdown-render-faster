// parse.js — a dependency-free CommonMark 0.31.2 + GFM 0.29 renderer.
// parse(markdown) returns exactly the HTML marked 18.1.3 renders with its
// default options (GFM on, breaks off, pedantic off, async off).
// Written from the CommonMark and GFM specifications; no third-party code.

// ---------------------------------------------------------------- utilities

// Document-level flag: an opening <a> tag seen in inline content
// suppresses bare autolinks (email/www/scheme) until a </a> is seen.
// It is set during inline scanning and persists across blocks (a
// marked quirk: an unclosed <a> in one paragraph disables bare
// autolinking in all later paragraphs). Reset at the start of parse().
let inATag = false;

const CODE = {
  SPACE: 32, TAB: 9, LF: 10, CR: 13, BANG: 33, QUOT: 34, HASH: 35, DOLLAR: 36,
  PERCENT: 37, AMP: 38, APOS: 39, LPAREN: 40, RPAREN: 41, STAR: 42, PLUS: 43,
  COMMA: 44, MINUS: 45, DOT: 46, SLASH: 47, COLON: 58, SEMI: 59, LT: 60,
  EQ: 61, GT: 62, QUEST: 63, AT: 64, LBRACK: 91, BACKSLASH: 92, RBRACK: 93,
  CARET: 94, UNDER: 95, BACKTICK: 96, LBRACE: 123, PIPE: 124, RBRACE: 125,
  TILDE: 126,
};

function isSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
}

// Unicode whitespace (CommonMark): Zs category + tab, LF, FF, CR.
function isUnicodeSpace(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
  return (
    c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x202f || c === 0x205f || c === 0x3000
  );
}

const ASCII_PUNCT = new Set(
  [...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'].map((s) => s.charCodeAt(0)),
);
const _punctCache = new Map();
const _punctRe = /^[\p{P}\p{S}]$/u;
// Unicode punctuation (CommonMark): ASCII punctuation or Unicode P or S category.
function isPunct(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_PUNCT.has(c);
  let r = _punctCache.get(ch);
  if (r === undefined) {
    r = _punctRe.test(ch);
    _punctCache.set(ch, r);
  }
  return r;
}

function isAlphaNum(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) {
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  }
  // Non-ASCII letter or digit: not whitespace, not punctuation.
  return !isUnicodeSpace(ch) && !isPunct(ch);
}

// ------------------------------------------------------------- HTML escaping

// Escape text content the way marked does: & < > " '
function escText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape for code spans / code blocks: & < > " ' (same set as text in marked).
function escCode(s) {
  return escText(s);
}

// An entity starting at s[i] === '&'. Returns { end, cp } or null.
// cp is -1 for a named entity (&name; with [A-Za-z0-9_]+): marked leaves it
// untouched. For a numeric entity it is the decoded code point, with 0 and
// surrogates mapped to U+FFFD. A numeric value above 0x10FFFF, or a missing
// ';', is not an entity at all (the '&' is then escaped).
function entityAt(s, i) {
  if (s[i] !== '&') return null;
  const n = s.length;
  if (s[i + 1] === '#') {
    let j = i + 2;
    let hex = false;
    if (s[j] === 'x' || s[j] === 'X') {
      hex = true;
      j++;
    }
    const start = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (hex ? (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)
              : (c >= 48 && c <= 57)) j++;
      else break;
    }
    if (j === start || s[j] !== ';') return null;
    const num = parseInt(s.slice(start, j), hex ? 16 : 10);
    if (num > 0x10ffff) return null;
    let cp = num;
    if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return { end: j + 1, cp };
  }
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) j++;
    else break;
  }
  if (j === i + 1 || s[j] !== ';') return null;
  return { end: j + 1, cp: -1 };
}

// Escape text content, leaving entity-shaped sequences alone and decoding
// valid numeric entities (then escaping the decoded character). This is
// marked's text escaping: &copy; stays, &#65; becomes A, a bare & becomes
// &amp;, < > " ' are escaped.
function escTextWithEntities(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 &&
      s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = '';
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '&') {
      const e = entityAt(s, i);
      if (e) {
        if (e.cp >= 0) {
          if (i > start) out += s.slice(start, i);
          out += escText(String.fromCodePoint(e.cp));
          i = e.end;
          start = i;
        } else {
          i = e.end; // named entity: leave as-is
        }
        continue;
      }
      if (i > start) out += s.slice(start, i);
      out += '&amp;';
      i++;
      start = i;
      continue;
    }
    let rep = null;
    if (ch === '<') rep = '&lt;';
    else if (ch === '>') rep = '&gt;';
    else if (ch === '"') rep = '&quot;';
    else if (ch === "'") rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      i++;
      start = i;
    } else i++;
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape for an attribute value (link title, fenced-code info word, image
// alt): entity-shaped sequences are left alone, other & becomes &amp;,
// < > " ' are escaped. No percent-encoding.
function escAttr(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 &&
      s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  let out = '';
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '&') {
      const e = entityAt(s, i);
      if (e) { i = e.end; continue; }
      if (i > start) out += s.slice(start, i);
      out += '&amp;';
      i++;
      start = i;
      continue;
    }
    let rep = null;
    if (ch === '<') rep = '&lt;';
    else if (ch === '>') rep = '&gt;';
    else if (ch === '"') rep = '&quot;';
    else if (ch === "'") rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      i++;
      start = i;
    } else i++;
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape a link destination for an href attribute. marked percent-encodes
// space " < > ` [ ] { }, control chars and non-ASCII (as UTF-8 %XX);
// ' becomes &#39;; & is left alone only when it starts a valid entity,
// otherwise it becomes &amp;. Other characters pass through.
function escHref(raw) {
  let out = '';
  let start = 0;
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const cp = raw.codePointAt(i);
    const step = cp > 0xffff ? 2 : 1;
    const ch = raw[i];
    if (ch === '&') {
      const e = entityAt(raw, i);
      if (e) { i = e.end; continue; }
      if (i > start) out += raw.slice(start, i);
      out += '&amp;';
      i += 1;
      start = i;
      continue;
    }
    let rep = null;
    if (ch === "'") rep = '&#39;';
    else if (ch === ' ' || ch === '"' || ch === '<' || ch === '>' || ch === '`' ||
             ch === '[' || ch === ']' || ch === '{' || ch === '}' || ch === '\\') {
      rep = '%' + cp.toString(16).toUpperCase().padStart(2, '0');
    } else if (cp < 32 || cp === 127) {
      rep = '%' + cp.toString(16).toUpperCase().padStart(2, '0');
    } else if (cp > 127) {
      const bytes = new TextEncoder().encode(String.fromCodePoint(cp));
      rep = '';
      for (const b of bytes) rep += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
    if (rep !== null) {
      if (i > start) out += raw.slice(start, i);
      out += rep;
      i += step;
      start = i;
    } else i += step;
  }
  return start === 0 ? raw : out + raw.slice(start);
}

// Escape a bare-URL (autolink) href or text: like escHref / escText, but
// every & becomes &amp; even when it looks like an entity.
function escBareHref(raw) {
  let out = '';
  let start = 0;
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const cp = raw.codePointAt(i);
    const step = cp > 0xffff ? 2 : 1;
    const ch = raw[i];
    let rep = null;
    if (ch === '&') rep = '&amp;';
    else if (ch === "'") rep = '&#39;';
    else if (ch === ' ' || ch === '"' || ch === '<' || ch === '>' || ch === '`' ||
             ch === '[' || ch === ']' || ch === '{' || ch === '}' || ch === '\\') {
      rep = '%' + cp.toString(16).toUpperCase().padStart(2, '0');
    } else if (cp < 32 || cp === 127) {
      rep = '%' + cp.toString(16).toUpperCase().padStart(2, '0');
    } else if (cp > 127) {
      const bytes = new TextEncoder().encode(String.fromCodePoint(cp));
      rep = '';
      for (const b of bytes) rep += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
    if (rep !== null) {
      if (i > start) out += raw.slice(start, i);
      out += rep;
      i += step;
      start = i;
    } else i += step;
  }
  return start === 0 ? raw : out + raw.slice(start);
}

// Escape a link title for a title="..." attribute.
function escTitle(raw) {
  return escAttr(raw);
}

// ---------------------------------------------------------- block structure

// Node shapes:
//  doc:    { t:'doc', c:[] }
//  para:   { t:'para', lines:[] }            (raw lines, dedented)
//  heading:{ t:'heading', level, text }      (inline source text)
//  code:   { t:'code', info, text, fenced }  (text = content, trailing \n per line)
//  html:   { t:'html', text }                (raw lines joined, each + \n)
//  quote:  { t:'quote', c:[] }
//  list:   { t:'list', ordered, start, delim, tight, c:[] }
//  item:   { t:'item', c:[], blank:false }
//  table:  { t:'table', align:[], head:[], rows:[] }
//  hr:     { t:'hr' }

const BLOCK_TAGS = new Set(
  ('address article aside base basefont blockquote body caption center col colgroup dd ' +
   'details dialog dir div dl dt fieldset figcaption figure footer form frame frameset ' +
   'h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav ' +
   'noframes ol optgroup option p param section source summary table tbody td tfoot th ' +
   'thead title tr track ul').split(' '),
);

function normalizeLabel(label) {
  // Whitespace collapsed, case-insensitive. Backslash escapes are NOT
  // resolved for matching: "foo\\!" and "foo!" are different labels.
  // Unicode case folding: ß / ẞ fold to "ss" (toLowerCase alone gives ß).
  const out = label.replace(/ß/g, 'ss').replace(/ẞ/g, 'ss');
  return out.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Parse a link destination starting at s[i] (after '[' or '(' handling).
// Returns { dest, next } or null. Handles <...> and bare destinations.
function parseDestination(s, i) {
  const n = s.length;
  if (s[i] === '<') {
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = s[j];
      if (c === '\n' || c === '<') return null;
      if (c === '>') return { dest: out, next: j + 1 };
      if (c === '\\' && j + 1 < n) {
        const d = s[j + 1];
        if (d === '\n') return null;
        if (isAsciiPunct(d)) { out += d; j += 2; continue; }
      }
      out += c;
      j++;
    }
    return null;
  }
  // Bare destination: no spaces/control chars; parens must balance.
  let j = i;
  let depth = 0;
  let out = '';
  while (j < n) {
    const c = s[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c.charCodeAt(0) < 32) break;
    if (c === '\\' && j + 1 < n) {
      const d = s[j + 1];
      if (isAsciiPunct(d)) { out += d; j += 2; continue; }
      out += '\\';
      j++;
      continue;
    }
    if (c === '(') {
      depth++;
      out += c;
      j++;
      continue;
    }
    if (c === ')') {
      if (depth === 0) break;
      depth--;
      out += c;
      j++;
      continue;
    }
    out += c;
    j++;
  }
  if (depth !== 0) return null;
  if (j === i) return null;
  return { dest: out, next: j };
}

function isAsciiPunct(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 && ASCII_PUNCT.has(c);
}

// Expand tabs in a code line to spaces, starting at column startCol.
// A tab advances to the next multiple of 4 columns.
function expandTabs(s, startCol) {
  if (s.indexOf('\t') === -1) return s;
  let out = '';
  let col = startCol;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else {
      out += c;
      col++;
    }
  }
  return out;
}

// Expand tabs in the leading whitespace run of a paragraph line,
// starting from column startCol. Only the leading run is expanded;
// tabs later in the line stay literal. Used when a paragraph line is
// inside a container (startCol > 0); at the top level tabs stay literal.
function expandLeadingTabs(s, startCol) {
  if (startCol <= 0) return s;
  let k = 0;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
  if (k === 0 || s.slice(0, k).indexOf('\t') === -1) return s;
  return expandTabs(s.slice(0, k), startCol) + s.slice(k);
}

// Effective column for a leading-tab expansion on a line inside a
// blockquote: the tab stop is measured from the outermost '>', so
// subtract the indent before the first '>' on the original line.
// (No '>' on the line, or a top-level line, gives no adjustment.)
function effCol(rawCol, line) {
  let qcol = 0;
  let qi = 0;
  while (qi < line.length && (line[qi] === ' ' || line[qi] === '\t')) {
    if (line[qi] === '\t') qcol += 4 - (qcol % 4); else qcol++;
    qi++;
  }
  if (qi < line.length && line[qi] === '>') return rawCol - qcol;
  return rawCol;
}

// Resolve backslash escapes (\ + ASCII punctuation -> the punctuation).
function resolveEscapes(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
      if (i > start) out += s.slice(start, i);
      out += s[i + 1];
      i++;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Parse a link title starting at s[i] (after optional whitespace).
// Returns { title, next } or null. Title may span lines.
function parseTitle(s, i) {
  const n = s.length;
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== '(') return null;
  const close = q === '(' ? ')' : q;
  let j = i + 1;
  let out = '';
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n) {
      const d = s[j + 1];
      if (d === '\n') {
        // Backslash-newline inside a title: not allowed to span a blank line;
        // a single newline is dropped (line continuation).
        j += 2;
        continue;
      }
      if (isAsciiPunct(d)) { out += d; j += 2; continue; }
      out += '\\';
      j++;
      continue;
    }
    if (c === close) return { title: out, next: j + 1 };
    if (q === '(' && (c === '(' || c === ')')) return null;
    out += c;
    j++;
  }
  return null;
}

// Skip spaces/tabs/newlines. Returns new index.
function skipSpaceNL(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  return i;
}

// Try to parse one link reference definition at the start of s (position 0).
// Returns { label, dest, title, end } (end = index just past the definition's
// line end) or null.
function parseRefDef(s) {
  const n = s.length;
  let i = 0;
  // Up to 3 leading spaces.
  let sp = 0;
  while (i < n && s[i] === ' ' && sp < 3) { i++; sp++; }
  if (s[i] !== '[') return null;
  // Label: [ ... ] with no unescaped '[' and no blank line.
  let j = i + 1;
  let label = '';
  let closed = false;
  while (j < n) {
    const c = s[j];
    if (c === '\n') {
      // A label may not contain a blank line; a single newline is ok (folded).
      if (s[j + 1] === '\n') return null;
      label += ' ';
      j++;
      continue;
    }
    if (c === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) {
      // Keep the escape intact: labels match with backslashes as written.
      label += c + s[j + 1];
      j += 2;
      continue;
    }
    if (c === '[') {
      // An unescaped '[' inside a reference label invalidates it.
      return null;
    }
    if (c === ']') {
      closed = true;
      break;
    }
    label += c;
    j++;
  }
  if (!closed) return null;
  if (label.length === 0) return null;
  const key = normalizeLabel(label);
  if (key === '') return null;
  j++; // past ']'
  if (s[j] !== ':') return null;
  j++;
  // Optional whitespace (incl. newlines, but not a blank line).
  let k = skipSpaceNL(s, j);
  if (k > j && s.slice(j, k).includes('\n\n')) return null;
  const dest = parseDestination(s, k);
  if (!dest) return null;
  let title = null;
  let end = dest.next;
  // A title must be separated from the destination by whitespace:
  // "<bar>(baz)" is not a destination plus a title.
  if (s[end] === '"' || s[end] === "'" || s[end] === '(') return null;
  // Optional title on the same or a following line.
  let m = skipSpaceNL(s, end);
  const titleOnNextLine = s.slice(end, m).includes('\n');
  if (m < n && (s[m] === '"' || s[m] === "'" || s[m] === '(')) {
    const t = parseTitle(s, m);
    if (!t) return null;
    title = t.title;
    end = t.next;
    m = skipSpaceNL(s, end);
  }
  // After the definition only spaces/tabs, then end of line.
  let p = end;
  while (p < n && (s[p] === ' ' || s[p] === '\t')) p++;
  if (p < n && s[p] !== '\n') {
    // Extra text after the title: if the title was on a following line,
    // drop the title (the definition is just the destination) and leave
    // the title line as paragraph text.
    if (title !== null && titleOnNextLine) {
      title = null;
      let e = dest.next;
      while (e < n && s[e] !== '\n') e++;
      end = e < n ? e + 1 : e;
      return { label: key, dest: dest.dest, title, end };
    }
    return null;
  }
  end = p < n ? p + 1 : p; // consume the newline
  return { label: key, dest: dest.dest, title, end };
}

// Extract leading link reference definitions from paragraph text.
// Returns { refs: [{label,dest,title}], rest: string }.
function extractRefDefs(text, refs) {
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    const r = parseRefDef(text.slice(pos));
    if (!r) break;
    if (!refs.has(r.label)) refs.set(r.label, { dest: r.dest, title: r.title });
    pos += r.end;
  }
  return text.slice(pos);
}

// ------------------------------------------------------------ line handling

function splitLines(src) {
  const s = src.replace(/\r\n?/g, '\n');
  const lines = s.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// A line cursor: text, offset (index), column (visual, tabs = next mult of 4).
function makeCursor(line) {
  return { text: line, off: 0, col: 0 };
}

// Consume up to `n` columns of indentation (spaces/tabs). Partially consumed
// tabs are replaced by spaces in the line text. Returns columns consumed.
function consumeIndent(cur, n) {
  let got = 0;
  while (got < n && cur.off < cur.text.length) {
    const c = cur.text[cur.off];
    if (c === ' ') {
      cur.off++;
      cur.col++;
      got++;
    } else if (c === '\t') {
      const w = 4 - (cur.col % 4);
      if (got + w <= n) {
        cur.off++;
        cur.col += w;
        got += w;
      } else {
        // Partial tab: replace it with spaces for the remainder and leave
        // the cursor at the first of those spaces (they are content).
        const rem = got + w - n;
        cur.text = cur.text.slice(0, cur.off) + ' '.repeat(rem) + cur.text.slice(cur.off + 1);
        cur.col += w - rem;
        got = n;
      }
    } else break;
  }
  return got;
}

// Count leading spaces (columns) without consuming. Returns { spaces, off }.
function leadingSpaces(cur) {
  let off = cur.off;
  let col = cur.col;
  while (off < cur.text.length) {
    const c = cur.text[off];
    if (c === ' ') { off++; col++; }
    else if (c === '\t') { const w = 4 - (col % 4); off++; col += w; }
    else break;
  }
  return { spaces: col - cur.col, off };
}

function isBlankLine(cur) {
  let off = cur.off;
  while (off < cur.text.length) {
    const c = cur.text[off];
    if (c !== ' ' && c !== '\t') return false;
    off++;
  }
  return true;
}

// ------------------------------------------------------------ block parsing

function parseBlocks(src) {
  const lines = splitLines(src);
  const refs = new Map();
  const root = { t: 'doc', c: [] };
  // Open container frames: { node, kind, indent? }
  const stack = [{ node: root, kind: 'doc' }];
  // Current open leaf block (para/code/html/table) or null.
  let leaf = null;
  // Whether the previous line was blank (for list tight/loose).
  let lastBlank = false;
  // Blank lines seen while a code block is open, not yet flushed into its
  // text: they belong to the code if more code follows, or mark the item
  // blank if the code block ends first. Accumulated as the blank lines'
  // text (content beyond the code indent, each followed by '\n').
  let pendingBlank = '';
  // contentBaseCol: absolute column where the innermost list item's
  // content starts for the line being processed (0 at top level). A tab
  // after '>' in a blockquote measures its tab stop from here, not from
  // the line start (marked). Reset each line; the container walk updates
  // it as list items consume their indent; tryBlockStart also reads it.
  let contentBaseCol = 0;

  // A code block is ending with deferred blank lines: fenced code keeps
  // them as text; indented code turns them into a blank mark on the item.
  function flushCodeBlank() {
    if (leaf && leaf.t === 'code' && pendingBlank.length > 0) {
      if (leaf.fenced) leaf.text += pendingBlank;
      else noteBlank();
      pendingBlank = '';
    }
  }

  function top() {
    return stack[stack.length - 1];
  }
  function addChild(node) {
    top().node.c.push(node);
  }
  // Close (finalize) blocks from the top of the stack down to (not incl.) idx.
  function closeTo(idx, atEof = false) {
    flushCodeBlank();
    while (stack.length > idx + 1) {
      const f = stack.pop();
      // A blank-marked item in a list that is closing had a blank line
      // inside it that no block in it resolved. The blank separates its
      // content from whatever comes next in its parent item, so
      // propagate the mark up (cm-325/326). This fires only when the
      // LIST closes, not when one item gives way to the next: a blank
      // between two items of a nested list loosens that list only.
      if (f.kind === 'list') {
        const lastItem = f.node.c[f.node.c.length - 1];
        if (lastItem && lastItem.t === 'item' && lastItem.blank && lastItem.c.length > 0) {
          for (let k = stack.length - 1; k >= 0; k--) {
            if (stack[k].kind === 'item') { stack[k].node.blank = true; break; }
            if (stack[k].kind === 'doc') break;
          }
        }
      }
      finalizeContainer(f.node, atEof);
    }
    if (leaf) {
      finalizeLeaf(leaf);
      leaf = null;
    }
  }
  function finalizeLeaf(lf) {
    if (lf.t === 'para') {
      const text = lf.lines.join('\n');
      const rest = extractRefDefs(text, refs);
      if (rest.trim() === '') {
        // Paragraph was only reference definitions: remove it.
        const parent = lf.parent;
        const arr = parent.c;
        const i = arr.indexOf(lf);
        if (i !== -1) arr.splice(i, 1);
      } else {
        lf.text = rest;
      }
      delete lf.lines;
      delete lf.parent;
    }
    // code/html/table need no finalization.
  }
  function finalizeContainer(node, atEof = false) {
    if (node.t === 'list') {
      // A list popped from the stack is closed: a later item starts a
      // new list rather than reusing this one.
      node.closed = true;
    }
    // An HTML block that is the last thing in a container loses its
    // trailing newline when the container closes mid-document (at EOF
    // the newline is kept).
    if (!atEof) {
      const last = node.c[node.c.length - 1];
      if (last && last.t === 'html' && last.text.endsWith('\n')) {
        last.text = last.text.slice(0, -1);
      }
    }
  }
  function closeLeaf() {
    if (leaf) {
      flushCodeBlank();
      finalizeLeaf(leaf);
      leaf = null;
    }
  }

  // Mark that a blank line occurred inside the innermost item(s).
  function noteBlank() {
    // Only the deepest container is marked: a blank line inside a nested
    // list or quote does not make an outer list loose.
    const f = stack[stack.length - 1];
    if (f && f.kind === 'item') f.node.blank = true;
  }
  // A new block is starting: for every item on the stack that saw a
  // blank line and already has children, the blank separated two blocks
  // in that item, so its enclosing list is loose. Checking every item
  // (not just the innermost) matters when the blank was inside a nested
  // item but the next block lands in an outer item (cm-325/326).
  function noteBlockStart() {
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i];
      if (f.kind === 'item') {
        if (f.node.blank && f.node.c.length > 0) {
          for (let k = i - 1; k >= 0; k--) {
            if (stack[k].kind === 'list') { stack[k].node.tight = false; break; }
            if (stack[k].kind === 'doc') break;
          }
        }
        f.node.blank = false;
      }
      if (f.kind === 'doc') break;
    }
  }
  // A new list item starts: if the previous item in the same list ended
  // with a blank line, the list is loose.
  function noteNewItem(listNode, prevItem) {
    if (prevItem && prevItem.blank) listNode.tight = false;
  }

  for (let li = 0; li < lines.length; li++) {
    const cur = makeCursor(lines[li]);
    let blank = isBlankLine(cur);

    // --- 1. Container continuation -------------------------------------
    // Walk open containers; close those that do not continue.
    // walkLazy: a paragraph line that failed to match an inner container
    // but is not a block start continues the paragraph lazily (the failed
    // container is treated as virtually matched, consuming nothing).
    // walkIndentConsumed: an item frame matched and consumed its indent.
    let walkLazy = false;
    let walkIndentConsumed = false;
    contentBaseCol = 0; // reset for this line; container walk updates it
    let closeIdx = stack.length - 1; // index of last continuing container
    let i = 1; // stack[0] is the document, always continues
    for (; i < stack.length; i++) {
      const f = stack[i];
      if (f.kind === 'quote') {
        const save = { off: cur.off, col: cur.col, text: cur.text };
        const ls = leadingSpaces(cur);
        if (ls.spaces <= 3) {
          cur.off = ls.off;
          cur.col = cur.col + ls.spaces;
        }
        if (cur.text[cur.off] === '>') {
          cur.off++;
          cur.col++;
          // One optional space/tab after '>'.
          if (cur.text[cur.off] === ' ') { cur.off++; cur.col++; }
          else if (cur.text[cur.off] === '\t') {
            // A tab after '>' counts as one space (partial tab handling):
            // consume one column of it and leave the rest as spaces.
            const w = 4 - ((cur.col - contentBaseCol) % 4);
            if (w === 1) { cur.off++; cur.col++; }
            else {
              cur.text = cur.text.slice(0, cur.off) + ' '.repeat(w - 1) + cur.text.slice(cur.off + 1);
              cur.col += 1;
            }
          }
          continue;
        }
        cur.off = save.off; cur.col = save.col; cur.text = save.text;
        // A line that only becomes blank once its containers are
        // consumed (a lone '>') is not a lazy continuation: it ends
        // the quote instead of virtually matching it.
        if (leaf && leaf.t === 'para' && !blank && !isBlankLine(cur) && !probeBlockStart(cur)) {
          walkLazy = true;
          continue;
        }
        break;
      } else if (f.kind === 'item') {
        // A blank line continues the item — including a line that only
        // becomes blank once its containers are consumed (a lone '>'
        // in a quote): the precomputed `blank` flag is false for it,
        // so check the remainder from the cursor too.
        if (blank || isBlankLine(cur)) continue;
        const ls = leadingSpaces(cur);
        if (ls.spaces >= f.indent) {
          consumeIndent(cur, f.indent);
          walkIndentConsumed = true;
          contentBaseCol = cur.col;
          continue;
        }
        // A list marker ends this item (it is not a lazy continuation):
        // a matching marker starts a new item in the parent list, and a
        // different marker (e.g. an ordered list not starting with 1, or
        // a different delimiter) starts a new list after this one.
        if (ls.spaces <= 3 && matchListMarker(cur.text.slice(ls.off))) {
          break;
        }
        if (leaf && leaf.t === 'para' && !probeBlockStart(cur)) {
          walkLazy = true;
          continue;
        }
        // A fenced code block that already has content keeps its lines
        // even when they don't match the item indent (they are code
        // content), unless the line starts a block. An empty fence does
        // not get this treatment.
        if (leaf && leaf.t === 'code' && leaf.fenced && leaf.text.length > 0 && !probeBlockStart(cur)) {
          walkLazy = true;
          continue;
        }
        break;
      } else if (f.kind === 'list') {
        continue; // a list itself consumes nothing
      } else {
        break;
      }
    }
    closeIdx = i - 1;
    if (closeIdx < stack.length - 1) {
      closeTo(closeIdx);
    }
    // A list left on the stack after its item closed only continues if
    // this line starts a new item for it; otherwise the list ends here
    // (e.g. a thematic break or heading after a list item).
    if (!blank && !walkLazy && stack.length > 1 && top().node.t === 'list') {
      const list = top().node;
      const pls = leadingSpaces(cur);
      const rest = cur.text.slice(pls.off);
      // A thematic break is not a list item even though it starts with a
      // list marker character: it closes the list.
      const isHr = pls.spaces <= 3 && /^([*_-])([ \t]*\1){2,}[ \t]*$/.test(rest);
      const m = pls.spaces <= 3 && !isHr ? matchListMarker(rest) : null;
      if (isHr || !m || m.ordered !== list.ordered || m.delim !== list.delim || m.marker !== list.marker) {
        closeTo(stack.length - 2);
      }
    }

    // A line that becomes blank after its containers are consumed (e.g. a
    // lone '>' in a quote) is a blank line: it ends the paragraph.
    if (!blank && isBlankLine(cur)) {
      blank = true;
    }

    if (blank) {
      // A whitespace-only line inside a table is an empty table row
      // only when it contains a tab (doc-02: a lone tab is an empty
      // row); a spaces-only line is a blank line that ends the table
      // (doc-03). A truly empty line ends it too.
      if (leaf && leaf.t === 'table') {
        const tail = cur.text.slice(cur.off);
        if (tail.length > 0 && tail.includes('\t')) {
          leaf.rows.push(splitTableRow(tail));
          continue;
        }
      }
      // EOF exception (cm-241): a whitespace-only line at the very end
      // of the document, with a paragraph open and non-empty content
      // remaining after its containers, appends that content to the
      // paragraph instead of ending it (e.g. `> foo\n>  \n` -> `foo\n `).
      if (leaf && leaf.t === 'para' && li === lines.length - 1) {
        const tail = cur.text.slice(cur.off);
        if (tail.length > 0) {
          leaf.lines.push(tail);
          leaf.lastLazy = false;
          continue;
        }
      }
      // Blank line: ends a paragraph; marks containers.
      if (leaf && leaf.t === 'para') closeLeaf();
      else if (leaf && leaf.t === 'table') { closeLeaf(); }
      // A blank line after an empty list item closes the item (a later
      // indented line is then outside the list, not its content). Mark
      // it blank first so the list still goes loose when the next item
      // starts (the blank line separates the items).
      if (!leaf) {
        const tf = top();
        if (tf.kind === 'item' && tf.node.c.length === 0) {
          tf.node.blank = true;
          closeTo(stack.length - 2);
        }
      }
      // A blank line inside an HTML block of type 1-5 is part of the
      // block (it continues through blank lines): append it and stay.
      if (leaf && leaf.t === 'html' && leaf.htmlType >= 1 && leaf.htmlType <= 5) {
        leaf.text += '\n';
        lastBlank = true;
        continue;
      }
      // A blank line also ends an HTML block of type 6/7 and a fenced
      // code block's... no: blank lines do not end fenced code.
      // The trailing-newline strip fires only for a truly empty line
      // (nothing left after the containers): a whitespace-only line
      // (spaces/tabs) does not strip it.
      const blankIsEmpty = cur.text.slice(cur.off).length === 0;
      if (leaf && leaf.t === 'html' && (leaf.htmlType === 6 || leaf.htmlType === 7)) {
        // An HTML block ending at a blank line loses its trailing
        // newline (any blank line ends it, whitespace-only included).
        if (leaf.text.endsWith('\n')) leaf.text = leaf.text.slice(0, -1);
        closeLeaf();
      }
      // An HTML block of any type that ended on the previous line and is
      // immediately followed by this blank line also loses its trailing
      // newline (e.g. a type-1 block closed by </script> just above).
      {
        const parent = top().node;
        const lastChild = parent.c[parent.c.length - 1];
        if (blankIsEmpty && lastChild && lastChild.t === 'html' && lastChild.text.endsWith('\n')) {
          lastChild.text = lastChild.text.slice(0, -1);
        }
      }
      if (leaf && leaf.t === 'code') {
        // Blank line inside a code block: defer it. It becomes part of
        // the code text if more code follows, and does NOT mark the item
        // blank (a blank inside code keeps the list tight). Backtick
        // fences strip up to the fence's indent from each line; tilde
        // fences strip nothing; indented code strips 4.
        const c2 = makeCursor(cur.text);
        c2.off = cur.off;
        c2.col = cur.col;
        if (!leaf.fenced) {
          consumeIndent(c2, 4);
          pendingBlank += c2.text.slice(c2.off) + '\n';
        } else if (leaf.fenceChar === '`') {
          // Strip up to the fence indent. A tab the strip cuts into
          // blanks the whole whitespace-only line (marked drops the
          // remainder; it does not leave remainder spaces, unlike
          // consumeIndent's partial-tab replacement); a tab the strip
          // stops exactly at stays literal. Mirrors the non-blank
          // content path's tab handling.
          let remaining = leaf.fenceIndent;
          let cutTab = false;
          while (remaining > 0 && c2.off < c2.text.length) {
            const ch = c2.text[c2.off];
            if (ch === ' ') { c2.off++; c2.col++; remaining--; }
            else if (ch === '\t') {
              const w = 4 - (c2.col % 4);
              c2.off++;
              c2.col += w;
              if (w <= remaining) remaining -= w;
              else { remaining = 0; cutTab = true; }
            } else break;
          }
          pendingBlank += cutTab ? '\n' : c2.text.slice(c2.off) + '\n';
        } else {
          // Tilde fence: no strip.
          pendingBlank += c2.text.slice(c2.off) + '\n';
        }
        lastBlank = true;
        continue;
      }
      noteBlank();
      lastBlank = true;
      continue;
    }
    lastBlank = false;

    // The offset just after the matched containers: paragraph and HTML
    // lines keep their text from here (leading spaces preserved).
    const rawOff = cur.off;
    const rawCol = cur.col;

    // --- 2. Try to start new blocks at the current position -------------
    // Helper: current indentation (columns) and position after it.
    const ls = leadingSpaces(cur);
    const indent = ls.spaces;
    const contentOff = ls.off;

    // If a leaf code/html block is open, the line is its content (unless
    // the fence closes, handled below).
    if (leaf && leaf.t === 'code' && leaf.fenced) {
      const save = { off: cur.off, col: cur.col, text: cur.text };
      cur.off = contentOff;
      cur.col = cur.col + indent;
      if (indent <= 3 && isClosingFence(cur, leaf)) {
        closeLeaf();
        continue;
      }
      cur.off = save.off; cur.col = save.col; cur.text = save.text;
      // Content line: flush deferred blanks. Backtick fences strip up
      // to the fence's indent from each line; tilde fences do not strip
      // at all (marked quirk). A leading tab then expands to the next
      // tab stop from the column after the outermost quote (one quote
      // level counts, not all); a non-leading tab stays literal.
      if (pendingBlank.length > 0) { leaf.text += pendingBlank; pendingBlank = ''; }
      const c2 = makeCursor(cur.text);
      c2.off = cur.off;
      c2.col = cur.col;
      const containerCol = cur.col;
      if (leaf.fenceChar === '`') {
        // Strip up to the fence indent. A tab the strip cuts into is
        // dropped entirely (not replaced with remainder spaces); a
        // tab the strip stops exactly at stays literal.
        let remaining = leaf.fenceIndent;
        while (remaining > 0 && c2.off < c2.text.length) {
          const ch = c2.text[c2.off];
          if (ch === ' ') { c2.off++; c2.col++; remaining--; }
          else if (ch === '\t') {
            const w = 4 - (c2.col % 4);
            c2.off++;
            c2.col += w;
            if (w <= remaining) remaining -= w;
            else remaining = 0;
          } else break;
        }
      }
      let codeLine = c2.text.slice(c2.off);
      // Tabs in the leading whitespace expand to the next tab stop,
      // but only inside a container (containerCol > 0); at the top
      // level they stay literal. The tab-stop column is measured from
      // the outermost '>' (one quote level counts, not all).
      if (containerCol > 0) {
        let baseCol = c2.col - 2 * Math.max(0, (leaf.quoteDepth || 0) - 1);
        if ((leaf.quoteDepth || 0) > 0) {
          let qcol = 0;
          // Use the original line: cur.text may have had its leading
          // tab partially consumed and replaced with spaces by the
          // container walk, which would undercount the indent before '>'.
          const lt = lines[li];
          let qi = 0;
          while (qi < lt.length && (lt[qi] === ' ' || lt[qi] === '\t')) {
            if (lt[qi] === '\t') qcol += 4 - (qcol % 4); else qcol++;
            qi++;
          }
          if (qi < lt.length && lt[qi] === '>') baseCol -= qcol;
        }
        let k = 0;
        let col = baseCol;
        let out = '';
        while (k < codeLine.length && (codeLine[k] === ' ' || codeLine[k] === '\t')) {
          if (codeLine[k] === ' ') { out += ' '; col++; k++; }
          else { const sp = 4 - (col % 4); out += ' '.repeat(sp); col += sp; k++; }
        }
        codeLine = out + codeLine.slice(k);
      }
      leaf.text += codeLine + '\n';
      continue;
    }
    if (leaf && leaf.t === 'code' && !leaf.fenced) {
      // Indented code: line continues if indent >= 4, or blank (handled
      // above). A line with indent < 4 ends the code block.
      if (indent >= 4) {
        if (pendingBlank.length > 0) { leaf.text += pendingBlank; pendingBlank = ''; }
        const c2 = makeCursor(cur.text);
        c2.off = cur.off;
        c2.col = cur.col;
        consumeIndent(c2, 4);
        leaf.text += c2.text.slice(c2.off) + '\n';
        continue;
      }
      closeLeaf();
      // Fall through to block-start processing.
    }
    if (leaf && leaf.t === 'html') {
      const t = leaf.htmlType;
      const lineText = cur.text.slice(rawOff);
      leaf.text += lineText + '\n';
      // When a type 1-5 block closes and the next line is blank, the
      // block loses its trailing newline.
      let closed = false;
      if (t === 1) {
        if (/<\/(script|pre|style|textarea)(?=[\s>\/]|$)/i.test(lineText)) closed = true;
      } else if (t === 2) {
        if (lineText.includes('-->')) closed = true;
      } else if (t === 3) {
        if (lineText.includes('?>')) closed = true;
      } else if (t === 4) {
        if (lineText.includes('>')) closed = true;
      } else if (t === 5) {
        if (lineText.includes(']]>')) closed = true;
      }
      if (closed) {
        // The trailing-newline strip fires only when the next line is
        // truly empty (a whitespace-only line does not strip it).
        if (li + 1 < lines.length && lines[li + 1].length === 0) {
          if (leaf.text.endsWith('\n')) leaf.text = leaf.text.slice(0, -1);
        }
        closeLeaf();
      }
      // Types 6/7 end at a blank line (handled above).
      continue;
    }

    // Table body rows: if a table is open, the line is a body row unless it
    // starts a new block that can interrupt.
    if (leaf && leaf.t === 'table') {
      if (indent <= 3) {
        cur.off = contentOff;
        cur.col = cur.col + indent;
        const probe = tryBlockStart(cur, indent, contentOff, true);
        if (probe) {
          closeLeaf();
          // fall through: process the block start below
        } else {
          leaf.rows.push(splitTableRow(cur.text.slice(contentOff)));
          continue;
        }
      } else {
        leaf.rows.push(splitTableRow(cur.text.slice(contentOff)));
        continue;
      }
    }

    // --- block starts (only when indent <= 3, except indented code) -----
    if (indent <= 3) {
      // Lazy continuation: the line failed to match an inner container but
      // is paragraph text (not a block start). Append it to the open
      // paragraph; the setext check is skipped for lazy lines, but the
      // table check still runs after the append.
      if (walkLazy && leaf && leaf.t === 'para') {
        let lineText;
        if (indent >= 4) {
          const cL = makeCursor(cur.text);
          cL.off = rawOff;
          cL.col = rawCol;
          consumeIndent(cL, 4);
          lineText = expandLeadingTabs(cL.text.slice(cL.off), cL.col);
        } else {
          lineText = expandLeadingTabs(cur.text.slice(rawOff), effCol(rawCol, lines[li]));
        }
        // A lazy setext underline that follows another lazy line gets
        // exactly 4 spaces (cm-093); a first lazy underline gets none.
        const trimmed = lineText.replace(/^[ \t]+/, '');
        if (leaf.lastLazy && /^(=+|-+)[ \t]*$/.test(trimmed)) {
          lineText = '    ' + trimmed;
        }
        leaf.lines.push(lineText);
        leaf.lastLazy = true;
        maybeMakeTable(indent);
        continue;
      }
      cur.off = contentOff;
      cur.col = cur.col + indent;
      // Setext heading: only if a paragraph is open.
      if (leaf && leaf.t === 'para') {
        const m = /^(=+|-+)[ \t]*$/.exec(cur.text.slice(cur.off));
        if (m) {
          const level = m[1][0] === '=' ? 1 : 2;
          const para = leaf;
          const rawText = para.lines.join('\n');
          const rest = extractRefDefs(rawText, refs);
          if (rest.trim() !== '') {
            // Replace the paragraph with the heading.
            const parent = para.parent;
            const arr = parent.c;
            const idx = arr.indexOf(para);
            closeLeaf();
            arr[idx] = { t: 'heading', level, text: rest.trim() };
            continue;
          }
          // Paragraph was only reference definitions: fall through and
          // process the underline line as a normal block start.
        }
      }
      const started = tryBlockStart(cur, indent, contentOff, false, rawOff);
      if (started === 'paragraph') {
        // tryBlockStart already handled it.
        continue;
      }
      if (started) continue;
      // Otherwise: paragraph text (or continuation).
      if (!leaf || leaf.t !== 'para') {
        noteBlockStart();
        closeLeaf();
        const p = { t: 'para', lines: [], parent: top().node };
        addChild(p);
        leaf = p;
      }
      // Paragraph lines keep their leading spaces (marked preserves them).
      // A leading tab inside a container expands to the next tab stop.
      leaf.lines.push(expandLeadingTabs(cur.text.slice(rawOff), effCol(rawCol, lines[li])));
      leaf.lastLazy = false;
      maybeMakeTable(indent);
      continue;
    }

    // indent >= 4
    if (!leaf || leaf.t !== 'para') {
      // Indented code block.
      noteBlockStart();
      closeLeaf();
      const c2 = makeCursor(cur.text);
      c2.off = cur.off;
      c2.col = cur.col;
      consumeIndent(c2, 4);
      const code = { t: 'code', info: '', text: c2.text.slice(c2.off) + '\n', fenced: false };
      addChild(code);
      leaf = code;
      continue;
    }
    // Paragraph continuation with 4+ indent: if a container consumed
    // indent (or the line was lazy), strip exactly 4 columns once;
    // otherwise the leading spaces are preserved.
    // Exception: a leading tab whose width measured from the outermost
    // '>' is under 4 columns is not 4 columns of indent at all — it
    // expands to fewer spaces and is not stripped (doc-17).
    if (walkLazy || walkIndentConsumed) {
      const rem = cur.text.slice(cur.off);
      const eff = effCol(rawCol, lines[li]);
      if (rem.startsWith('\t') && eff % 4 !== 0) {
        leaf.lines.push(expandLeadingTabs(cur.text.slice(rawOff), eff));
        leaf.lastLazy = walkLazy;
      } else {
        const c3 = makeCursor(cur.text);
        c3.off = cur.off;
        c3.col = cur.col;
        consumeIndent(c3, 4);
        leaf.lines.push(c3.text.slice(c3.off));
        leaf.lastLazy = walkLazy;
      }
    } else {
      leaf.lines.push(expandLeadingTabs(cur.text.slice(rawOff), effCol(rawCol, lines[li])));
      leaf.lastLazy = false;
    }
  }

  // End of input: close everything.
  closeTo(0, true);
  return { root, refs };

  // ------------------------------------------------------------ helpers
  function isClosingFence(cur, leaf) {
    const s = cur.text.slice(cur.off);
    const ch = s[0];
    if (ch !== leaf.fenceChar) return false;
    let n = 0;
    while (s[n] === ch) n++;
    if (n < leaf.fenceLen) return false;
    const rest = s.slice(n);
    return /^[ \t]*$/.test(rest);
  }

  // Would a block start at the current position (after matched containers)?
  // Used for lazy continuation: a paragraph line that failed to match an
  // inner container is lazy text unless a block would start there. A line
  // indented 4+ columns is never a block start.
  function probeBlockStart(cur) {
    const pls = leadingSpaces(cur);
    if (pls.spaces >= 4) return false;
    const save = { off: cur.off, col: cur.col };
    cur.off = pls.off;
    cur.col = cur.col + pls.spaces;
    const r = tryBlockStart(cur, pls.spaces, pls.off, true);
    cur.off = save.off;
    cur.col = save.col;
    return r;
  }

  // After a paragraph line was appended, check whether it is a table
  // delimiter row whose previous line is the header. The delimiter line
  // must be indented at most 3 columns and contain an unescaped '|'.
  // The header is the paragraph's LAST line; lines before it stay a para.
  function maybeMakeTable(delimIndent) {
    if (!leaf || leaf.t !== 'para' || leaf.lines.length < 2) return;
    if (delimIndent > 3) return;
    const delimLine = leaf.lines[leaf.lines.length - 1];
    const align = tableDelimiter(delimLine);
    if (!align) return;
    const headerLine = leaf.lines[leaf.lines.length - 2];
    const head = splitTableRow(headerLine);
    if (head.length !== align.length) return;
    const para = leaf;
    const parent = para.parent;
    const idx = parent.c.indexOf(para);
    const table = { t: 'table', align, head, rows: [] };
    if (leaf.lines.length > 2) {
      para.lines = leaf.lines.slice(0, leaf.lines.length - 2);
      parent.c.splice(idx + 1, 0, table);
    } else {
      parent.c.splice(idx, 1, table);
    }
    leaf = table;
  }

  // Try to start a block at cur (already positioned after indent).
  // Returns true if a block was started (or the line consumed), 'paragraph'
  // if the caller should treat it as paragraph text, or false.
  // When probeOnly is true, only report whether a block WOULD start.
  function tryBlockStart(cur, indent, contentOff, probeOnly, rawOff) {
    const s = cur.text.slice(cur.off);
    if (s.length === 0) return false;

    // ATX heading
    if (s[0] === '#') {
      let n = 0;
      while (s[n] === '#') n++;
      if (n >= 1 && n <= 6 && (s[n] === ' ' || s[n] === '\t' || s[n] === undefined)) {
        if (probeOnly) return true;
        noteBlockStart();
        closeLeaf();
        // Heading text: trim, then strip one trailing run of #s that is
        // preceded by a space/tab (the closing sequence).
        let text = s.slice(n);
        text = text.replace(/[ \t]+$/, '');
        text = text.replace(/[ \t]+#+$/, '');
        text = text.trim();
        addChild({ t: 'heading', level: n, text });
        return true;
      }
    }

    // Fenced code
    if (s[0] === '`' || s[0] === '~') {
      const ch = s[0];
      let n = 0;
      while (s[n] === ch) n++;
      if (n >= 3) {
        const info = resolveEscapes(s.slice(n).trim());
        if (ch === '`' && info.includes('`')) {
          // Not a fence; fall through.
        } else {
          if (probeOnly) return true;
          noteBlockStart();
          closeLeaf();
          // Quote depth at fence creation: a tab in the content expands
          // from the column after the outermost quote only (marked
          // counts one quote level, not all of them, for the tab stop).
          let qd = 0;
          for (const f of stack) if (f.kind === 'quote') qd++;
          const code = {
            t: 'code', info, text: '', fenced: true,
            fenceChar: ch, fenceLen: n, fenceIndent: indent, quoteDepth: qd,
          };
          addChild(code);
          leaf = code;
          return true;
        }
      }
    }

    // Thematic break
    if (/^([*_-])([ \t]*\1){2,}[ \t]*$/.test(s)) {
      if (probeOnly) return true;
      noteBlockStart();
      closeLeaf();
      addChild({ t: 'hr' });
      return true;
    }

    // Blockquote
    if (s[0] === '>') {
      if (probeOnly) return true;
      noteBlockStart();
      closeLeaf();
      const q = { t: 'quote', c: [] };
      addChild(q);
      stack.push({ node: q, kind: 'quote' });
      // Consume '>' + one optional space, then reprocess the line.
      cur.off++;
      cur.col++;
      if (cur.text[cur.off] === ' ') { cur.off++; cur.col++; }
      else if (cur.text[cur.off] === '\t') {
        const w = 4 - ((cur.col - contentBaseCol) % 4);
        if (w === 1) { cur.off++; cur.col++; }
        else {
          cur.text = cur.text.slice(0, cur.off) + ' '.repeat(w - 1) + cur.text.slice(cur.off + 1);
          cur.col += 1;
        }
      }
      reprocessLine(cur);
      return true;
    }

    // HTML block (types 1-6 can interrupt a paragraph; type 7 cannot)
    const htmlType = htmlBlockType(s, leaf && leaf.t === 'para');
    if (htmlType > 0) {
      if (probeOnly) return true;
      noteBlockStart();
      closeLeaf();
      // The opening line keeps its raw text (leading spaces included).
      const html = { t: 'html', text: cur.text.slice(rawOff) + '\n', htmlType };
      addChild(html);
      // Types 1-5 may end on the opening line itself.
      let htmlLeaf = html;
      if (htmlType === 1) {
        const openIdx = s.search(/<(script|pre|style|textarea)(\s|>)/i);
        const closeIdx = s.search(/<\/(script|pre|style|textarea)(?=[\s>\/]|$)/i);
        if (closeIdx > openIdx) htmlLeaf = null;
      } else if (htmlType === 2 && s.includes('-->')) htmlLeaf = null;
      else if (htmlType === 3 && s.includes('?>')) htmlLeaf = null;
      else if (htmlType === 4 && s.includes('>')) htmlLeaf = null;
      else if (htmlType === 5 && s.includes(']]>')) htmlLeaf = null;
      leaf = htmlLeaf;
      return true;
    }

    // List item
    const listM = matchListMarker(s);
    if (listM) {
      // A list can interrupt a paragraph only if: bullet list, or ordered
      // starting with 1. But that restriction applies only to a top-level
      // paragraph: inside a list item or quote, any ordered list can start
      // (it is a nested list, not an interruption of a bare paragraph).
      // An empty item cannot interrupt a paragraph.
      const canInterrupt =
        !leaf || leaf.t !== 'para' ||
        top().node.t !== 'doc' ||
        (listM.ordered ? listM.start === 1 : true);
      const isEmpty = listM.after === '';
      if (!canInterrupt || (isEmpty && leaf && leaf.t === 'para')) {
        // Treat as paragraph text.
        return false;
      }
      if (probeOnly) return true;
      noteBlockStart();
      closeLeaf();
      startListItem(cur, listM, indent);
      return true;
    }

    // Indented code cannot interrupt a paragraph; handled by caller.
    return false;
  }

  // After starting a blockquote (or any container), reprocess the remainder
  // of the current line as if it were a fresh line. Implemented by
  // re-running the block-start logic on the same line via a small loop.
  // We emulate it by returning to the main loop's block-start section:
  // here we handle it inline for the blockquote case by processing the
  // rest of the line with a recursive call into a line processor.
  function reprocessLine(cur) {
    // Process the remainder of the line: it may start another block or be
    // paragraph text. We handle the common cases directly. The remainder
    // keeps its text from rOff (the position after the container marker).
    const rOff = cur.off;
    const ls = leadingSpaces(cur);
    const ind = ls.spaces;
    if (ind <= 3) {
      cur.off = ls.off;
      cur.col = cur.col + ind;
      if (cur.off >= cur.text.length) {
        // Empty remainder: nothing to do (a blank inside the quote).
        return;
      }
      const started = tryBlockStart(cur, ind, ls.off, false, rOff);
      if (started) return;
      if (!leaf || leaf.t !== 'para') {
        noteBlockStart();
        closeLeaf();
        const p = { t: 'para', lines: [], parent: top().node };
        addChild(p);
        leaf = p;
      }
      leaf.lines.push(cur.text.slice(rOff));
      maybeMakeTable(ind);
      return;
    }
    // ind >= 4: indented code or paragraph continuation.
    if (!leaf || leaf.t !== 'para') {
      noteBlockStart();
      closeLeaf();
      const c2 = makeCursor(cur.text);
      c2.off = cur.off;
      c2.col = cur.col;
      consumeIndent(c2, 4);
      const code = { t: 'code', info: '', text: c2.text.slice(c2.off) + '\n', fenced: false };
      addChild(code);
      leaf = code;
      return;
    }
    // A container was just consumed, so strip 4 columns once.
    const c3 = makeCursor(cur.text);
    c3.off = cur.off;
    c3.col = cur.col;
    consumeIndent(c3, 4);
    leaf.lines.push(c3.text.slice(c3.off));
  }

  function startListItem(cur, listM, indent) {
    // Find or create the list: if the current container IS a list with a
    // matching marker, use it; else if its last child is such a list, use
    // that (pushing it back on the stack); else create a new list here.
    let list = null;
    const topNode = top().node;
    if (
      topNode.t === 'list' &&
      topNode.ordered === listM.ordered &&
      topNode.delim === listM.delim &&
      topNode.marker === listM.marker &&
      !topNode.closed
    ) {
      list = topNode;
    } else {
      const last = topNode.c[topNode.c.length - 1];
      if (
        last && last.t === 'list' &&
        last.ordered === listM.ordered &&
        last.delim === listM.delim &&
        last.marker === listM.marker &&
        !last.closed
      ) {
        list = last;
        stack.push({ node: list, kind: 'list' });
      } else {
        if (last && last.t === 'list') last.closed = true;
        list = {
          t: 'list', ordered: listM.ordered, start: listM.start,
          delim: listM.delim, marker: listM.marker, tight: true, c: [],
        };
        topNode.c.push(list);
        stack.push({ node: list, kind: 'list' });
      }
    }
    const prevItem = list.c[list.c.length - 1];
    noteNewItem(list, prevItem);
    const item = { t: 'item', c: [], blank: false };
    list.c.push(item);
    // The item indent is the marker's offset from the container start
    // plus the content indent (both relative to the container, so it is
    // stable across lines whose container markers sit at different
    // columns). The walk compares the line's leading spaces to it.
    stack.push({ node: item, kind: 'item', indent: indent + listM.contentIndent });
    // Position after the marker, then consume up to the content indent.
    // Content past contentIndent + 4 columns is indented code, so do NOT
    // consume all the spaces after the marker.
    cur.off += listM.markerLen;
    cur.col += listM.markerLen;
    consumeIndent(cur, listM.contentIndent - listM.markerLen);
    if (cur.off >= cur.text.length) {
      // Empty item: nothing more on this line.
      return;
    }
    // The remainder is content: reprocess as a fresh line.
    reprocessLine(cur);
  }
}

// Match a list marker at the start of s. Returns null or:
// { ordered, start, delim, marker, markerLen, spaceLen, contentIndent, after }
function matchListMarker(s) {
  const c0 = s[0];
  if (c0 === '-' || c0 === '+' || c0 === '*') {
    if (s[1] === ' ' || s[1] === '\t' || s[1] === undefined) {
      const markerLen = 1;
      const { spaceLen, contentIndent } = listSpaceAfter(s, markerLen);
      const after = s.slice(markerLen + spaceLen);
      // An empty item (nothing after the marker and spaces) has content
      // indent markerLen + 1, however many spaces follow the marker.
      const ci = after === '' ? markerLen + 1 : contentIndent;
      return {
        ordered: false, start: 0, delim: '', marker: c0,
        markerLen, spaceLen, contentIndent: ci, after,
      };
    }
    return null;
  }
  if (c0 >= '0' && c0 <= '9') {
    let n = 0;
    while (s[n] >= '0' && s[n] <= '9') n++;
    if (n > 9) return null;
    const delim = s[n];
    if ((delim === '.' || delim === ')') && (s[n + 1] === ' ' || s[n + 1] === '\t' || s[n + 1] === undefined)) {
      const markerLen = n + 1;
      const { spaceLen, contentIndent } = listSpaceAfter(s, markerLen);
      const after = s.slice(markerLen + spaceLen);
      const ci = after === '' ? markerLen + 1 : contentIndent;
      return {
        ordered: true, start: parseInt(s.slice(0, n), 10), delim,
        marker: '', markerLen, spaceLen, contentIndent: ci, after,
      };
    }
  }
  return null;
}

// After a list marker, count the following whitespace and compute the
// content indent (columns from the line start). Returns { spaceLen,
// contentIndent }. spaceLen is the number of whitespace characters;
// contentIndent the column. The whitespace (spaces and tabs, expanded to
// columns) is summed: 1-4 columns give marker + columns, 5 or more give
// marker + 1.
function listSpaceAfter(s, markerLen) {
  let i = markerLen;
  let cols = 0;
  let chars = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { cols++; chars++; i++; }
    else if (c === '\t') { cols += 4 - ((markerLen + cols) % 4); chars++; i++; }
    else break;
  }
  if (cols === 0) {
    return { spaceLen: 0, contentIndent: markerLen + 1 };
  }
  if (cols >= 5) {
    return { spaceLen: chars, contentIndent: markerLen + 1 };
  }
  return { spaceLen: chars, contentIndent: markerLen + cols };
}

// Determine the HTML block type (1-7) for a line, or 0. When a paragraph is
// open, type 7 cannot interrupt it.
function htmlBlockType(s, inPara) {
  if (s[0] !== '<') return 0;
  const lower = s.toLowerCase();
  if (/^<(script|pre|style|textarea)(\s|>|\/>|$)/.test(lower)) return 1;
  if (lower.startsWith('<!--')) return 2;
  if (lower.startsWith('<?')) return 3;
  if (/^<![a-z]/.test(lower)) return 4;
  if (lower.startsWith('<![cdata[')) return 5;
  // Type 6: line begins with a block-level tag (open or close). The rest
  // of the line is part of the block. The tag may span lines.
  const m6 = /^<\/?([a-z][a-z0-9-]*)(\s|>|\/>|$)/.exec(lower);
  if (m6 && BLOCK_TAGS.has(m6[1])) return 6;
  // Type 7: a complete open/close tag alone on the line. Cannot
  // interrupt a paragraph. A tag that spans lines (no '>' yet) is NOT
  // type 7 (only block-level tags may span lines, as type 6). The tag
  // itself must be valid (attributes checked), not merely contain '>'.
  if (!inPara) {
    const tag = tryOpenCloseTag(s, 0);
    if (tag) {
      const rest = s.slice(tag.end);
      if (/^[ \t]*$/.test(rest)) return 7;
    }
  }
  return 0;
}

// Split a table row line into cells. marked splits on every UNESCAPED '|'
// (a pipe preceded by an odd number of backslashes is escaped and stays,
// backslash included); pipes inside code spans DO split. Each cell is
// trimmed, then the leading cell is dropped if empty and the trailing cell
// is dropped if empty (once each).
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === '|') {
      let bs = 0;
      let j = i - 1;
      while (j >= 0 && line[j] === '\\') { bs++; j--; }
      if (bs % 2 === 1) {
        // Escaped pipe: not a delimiter, and the escape backslash is
        // removed from the cell content (so `a \| b` becomes `a | b`).
        cur = cur.slice(0, -1) + c;
        i++;
        continue;
      }
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  cells.push(cur);
  const trimmed = cells.map((c) => c.trim());
  if (trimmed.length > 0 && trimmed[0] === '') trimmed.shift();
  if (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
  return trimmed;
}

// Check whether a line is a table delimiter row. Returns align array or null.
// The delimiter line must contain an unescaped '|' (so a bare '---' under a
// one-cell header is a setext underline, not a table).
function tableDelimiter(line) {
  let hasPipe = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|') {
      let bs = 0;
      let j = i - 1;
      while (j >= 0 && line[j] === '\\') { bs++; j--; }
      if (bs % 2 === 0) { hasPipe = true; break; }
    }
  }
  if (!hasPipe) return null;
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const align = [];
  for (const cell of cells) {
    const m = /^:?-+:?$/.exec(cell);
    if (!m) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return align;
}

// ------------------------------------------------------------ inline parsing

// Inline node shapes:
//  { t:'text', s }                    plain text (escapes resolved)
//  { t:'code', s }                    code span content
//  { t:'em'|'strong'|'del', c }      emphasis nodes (children)
//  { t:'link', href, title, c }      a link (children = label nodes)
//  { t:'link', href, display, bare } a bare-URL / autolink (encode-all)
//  { t:'img', src, alt, title }      an image
//  { t:'html', s }                    raw inline HTML
//  { t:'br' }                         hard line break
//  { t:'delim', ch, n, canOpen, canClose }  a delimiter run left literal

// Scan a link label starting at src[i] === '['. Skips code spans and
// handles backslash escapes and nested brackets. Returns
// { text, end } (end = index just past ']') or null.
// Scan a link/image label starting at src[i] === '['.
// Returns { text, end } (end is just past ']') or null.
// allowNested: images allow nested brackets (depth-counted); link labels
// must not contain an unescaped '[' (a nested bracket invalidates the label).
// checkTags: for link labels, a '<' that starts an HTML tag enters tag mode;
// a ']' inside an unclosed quoted attribute value is swallowed by the quote,
// so if the quote never closes the label never ends (null). Images do not
// do this check (an unclosed quote in an image label is just alt text).
function scanLabel(src, i, allowNested, checkTags) {
  const n = src.length;
  let j = i + 1;
  let depth = 0;
  let badCodeSpan = false;
  // Once a backtick run has no matching closer, later backtick runs
  // in this label are literal (they cannot span past a ']'); the
  // label then closes at the next ']' at this depth.
  let codeSpanBroken = false;
  while (j < n) {
    const c = src[j];
    if (c === '\\' && j + 1 < n && isAsciiPunct(src[j + 1])) { j += 2; continue; }
    if (c === '`') {
      let k = j;
      let ticks = 0;
      while (k < n && src[k] === '`') { ticks++; k++; }
      if (codeSpanBroken) { j = k; continue; }
      let m = k;
      let found = -1;
      while (m < n) {
        // A ']' that would close this label, reached while the code
        // span content so far contains a backtick, ends the span
        // search: the span does not reach past the ']', and the label
        // closes there (doc-09). A span whose content has no backtick
        // may still span past the ']' (cm-342).
        if (src[m] === ']' && depth === 0 && src.slice(k, m).includes('`')) {
          found = -1;
          break;
        }
        if (src[m] === '`') {
          let t = 0;
          while (m + t < n && src[m + t] === '`') t++;
          if (t === ticks) { found = m + t; break; }
          m += t;
        } else m++;
      }
      if (found !== -1) {
        // A code span whose content contains a backtick invalidates
        // the label (as a link) unless it is immediately followed by
        // the closing ']' (it is the last thing in the label). The
        // label is still found, but flagged, so the caller can
        // suppress emphasis inside it (the label text was already
        // consumed by the failed link attempt).
        const content = src.slice(k, found - ticks);
        if (content.includes('`') && src[found] !== ']') badCodeSpan = true;
        j = found;
        continue;
      }
      codeSpanBroken = true;
      j = k;
      continue;
    }
    if (checkTags && c === '<') {
      const d = src[j + 1];
      const isTag = (d >= 'a' && d <= 'z') || (d >= 'A' && d <= 'Z') || d === '!' || d === '?' || (d === '/' && ((src[j + 2] >= 'a' && src[j + 2] <= 'z') || (src[j + 2] >= 'A' && src[j + 2] <= 'Z')));
      if (isTag) {
        // Tag/autolink mode: scan to '>' tracking quotes. A ']' inside
        // the <...> is part of the tag or URL, never a label terminator
        // (cm-526/538: the ']' inside <https://...?search=](uri)>).
        let quote = null;
        j++;
        let tagDone = false;
        while (j < n) {
          const tc = src[j];
          if (quote) {
            if (tc === quote) quote = null;
            j++;
            continue;
          }
          if (tc === '"' || tc === "'") { quote = tc; j++; continue; }
          if (tc === '>') { tagDone = true; j++; break; }
          j++;
        }
        if (!tagDone && j >= n) return null;
        continue;
      }
    }
    if (c === '[') {
      if (!allowNested) return null;
      depth++;
      j++;
      continue;
    }
    if (c === ']') {
      if (depth === 0) return { text: src.slice(i + 1, j), end: j + 1, badCodeSpan, codeSpanBroken };
      depth--;
      j++;
      continue;
    }
    j++;
  }
  return null;
}

// Scan a code span starting at src[i] === '`'. Returns { text, end } or
// null. Content: newlines become spaces; one leading and one trailing
// space are stripped when both are present and the content is not all
// spaces.
function scanCodeSpan(src, i) {
  const n = src.length;
  let j = i;
  let ticks = 0;
  while (j < n && src[j] === '`') { ticks++; j++; }
  let k = j;
  while (k < n) {
    if (src[k] === '`') {
      let t = 0;
      while (k + t < n && src[k + t] === '`') t++;
      if (t === ticks) {
        let content = src.slice(j, k).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' &&
            content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        return { text: content, end: k + t };
      }
      k += t;
    } else k++;
  }
  return null;
}

// Count backslash-escapes (a backslash followed by ASCII punctuation) in
// src[a..b). Each one shrinks the resolved text by one character.
function countEscapesIn(src, a, b) {
  let c = 0;
  for (let j = a; j + 1 < b; j++) {
    if (src[j] === '\\' && isAsciiPunct(src[j + 1])) { c++; j++; }
  }
  return c;
}

// Try to parse an open/close HTML tag starting at src[i] === '<'.
// Returns { end } or null. Attribute names start with a letter, '_' or
// ':'; values may be quoted (and contain '>') or unquoted (no space, '"',
// "'", '=', '<', '>', backtick); attributes must be preceded by
// whitespace; '/' only as '/>'; a closing tag takes no attributes.
function tryOpenCloseTag(src, i) {
  const n = src.length;
  let j = i + 1;
  let closing = false;
  if (src[j] === '/') { closing = true; j++; }
  if (j >= n || !/[A-Za-z]/.test(src[j])) return null;
  let k = j + 1;
  while (k < n && /[A-Za-z0-9-]/.test(src[k])) k++;
  if (closing) {
    let m = k;
    while (m < n && (src[m] === ' ' || src[m] === '\t' || src[m] === '\n')) m++;
    if (src[m] === '>') return { end: m + 1 };
    return null;
  }
  let m = k;
  while (m < n) {
    const c = src[m];
    if (c === '>') return { end: m + 1 };
    if (c === '/') {
      if (src[m + 1] === '>') return { end: m + 2 };
      return null;
    }
    if (c === ' ' || c === '\t' || c === '\n') {
      let a = m;
      while (a < n && (src[a] === ' ' || src[a] === '\t' || src[a] === '\n')) a++;
      if (a >= n) return null;
      if (src[a] === '>') { m = a; continue; }
      if (src[a] === '/') {
        if (src[a + 1] === '>') return { end: a + 2 };
        return null;
      }
      if (!/[A-Za-z_:]/.test(src[a])) return null;
      let b = a + 1;
      while (b < n && /[A-Za-z0-9_.:-]/.test(src[b])) b++;
      let d = b;
      while (d < n && (src[d] === ' ' || src[d] === '\t' || src[d] === '\n')) d++;
      if (src[d] === '=') {
        d++;
        while (d < n && (src[d] === ' ' || src[d] === '\t' || src[d] === '\n')) d++;
        if (src[d] === '"') {
          d++;
          while (d < n && src[d] !== '"') d++;
          if (d >= n) return null;
          d++;
        } else if (src[d] === "'") {
          d++;
          while (d < n && src[d] !== "'") d++;
          if (d >= n) return null;
          d++;
        } else {
          let e = d;
          while (e < n && !/[ \t\n"'=<`>]/.test(src[e])) e++;
          if (e === d) return null;
          d = e;
        }
        m = d;
      } else {
        // Attribute without a value: resume just after the name so the
        // following whitespace is consumed by the main loop.
        m = b;
      }
      continue;
    }
    return null;
  }
  return null;
}

// Try to parse an inline HTML construct or bracket autolink at src[i] ===
// '<'. Returns { node, end } or null. Order: comment, processing
// instruction, declaration, CDATA, scheme autolink, strict email autolink,
// open/close tag.
function tryHtmlTag(src, i) {
  const n = src.length;
  const rest = src.slice(i);
  if (rest.startsWith('<!--')) {
    const end = src.indexOf('-->', i + 2);
    if (end !== -1) return { node: { t: 'html', s: src.slice(i, end + 3) }, end: end + 3 };
    return null;
  }
  if (rest.startsWith('<?')) {
    const end = src.indexOf('?>', i + 2);
    if (end !== -1) return { node: { t: 'html', s: src.slice(i, end + 2) }, end: end + 2 };
    return null;
  }
  if (rest.startsWith('<!') && i + 2 < n && /[A-Za-z]/.test(src[i + 2])) {
    const end = src.indexOf('>', i + 2);
    if (end !== -1) return { node: { t: 'html', s: src.slice(i, end + 1) }, end: end + 1 };
    return null;
  }
  if (rest.startsWith('<![CDATA[')) {
    const end = src.indexOf(']]>', i + 9);
    if (end !== -1) return { node: { t: 'html', s: src.slice(i, end + 3) }, end: end + 3 };
    return null;
  }
  // Scheme autolink: <scheme:...> with a 2..32 char scheme.
  const afterLt = rest.slice(1);
  const schemeM = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):([^\s<>]*)>/.exec(afterLt);
  if (schemeM && schemeM[2].length > 0) {
    const url = schemeM[1] + ':' + schemeM[2];
    return {
      node: { t: 'link', href: url, display: url, bare: true, bracket: true },
      end: i + 1 + schemeM[0].length,
    };
  }
  // Strict email autolink: <local@domain> (CommonMark email pattern).
  const emailM = /^([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)>/.exec(afterLt);
  if (emailM) {
    const email = emailM[1];
    return {
      node: { t: 'link', href: 'mailto:' + email, display: email, bare: true, bracket: true },
      end: i + 1 + emailM[0].length,
    };
  }
  const tag = tryOpenCloseTag(src, i);
  if (tag) return { node: { t: 'html', s: src.slice(i, tag.end) }, end: tag.end };
  return null;
}

// Try an inline link destination+title starting at src[i] === '('.
// labelEnd is the index just past ']'. Returns { dest, title, end } or
// null. The destination may be empty; the title may be on the next line.
function tryInlineLink(src, labelEnd) {
  let i = labelEnd + 1; // just past '('
  i = skipSpaceNL(src, i);
  if (src[i] === ')') return { dest: '', title: null, end: i + 1 };
  const dest = parseDestination(src, i);
  if (!dest) return null;
  // A title must be separated from the destination by whitespace.
  if (src[dest.next] === '"' || src[dest.next] === "'" || src[dest.next] === '(') return null;
  let j = skipSpaceNL(src, dest.next);
  let title = null;
  if (src[j] === '"' || src[j] === "'" || src[j] === '(') {
    const t = parseTitle(src, j);
    if (!t) return null;
    title = t.title;
    j = skipSpaceNL(src, t.next);
  }
  if (src[j] !== ')') return null;
  return { dest: dest.dest, title, end: j + 1 };
}

// Try a full or collapsed reference link: src[labelEnd] === '['.
// Returns { dest, title, end } or null.
function tryRefLink(src, label, labelEnd, refs) {
  if (src[labelEnd] !== '[') return null;
  const lab2 = scanLabel(src, labelEnd, false, true);
  if (!lab2 || lab2.badCodeSpan) return null;
  const key = lab2.text === '' ? normalizeLabel(label) : normalizeLabel(lab2.text);
  if (key === '') return null;
  const ref = refs.get(key);
  if (!ref) return null;
  return { dest: ref.dest, title: ref.title, end: lab2.end };
}

// Try a shortcut reference link for a label. Returns { dest, title } or null.
function tryShortcut(label, refs) {
  const key = normalizeLabel(label);
  if (key === '') return null;
  const ref = refs.get(key);
  if (!ref) return null;
  return { dest: ref.dest, title: ref.title };
}

// Does this node list contain a (non-bare) link node at any depth?
// Bare autolinks do not block an outer link: a label may contain one
// and the outer link still forms (the autolink renders inside it).
function containsLink(nodes) {
  for (const node of nodes) {
    if (node.t === 'link' && !node.bare) return true;
    if (node.c && containsLink(node.c)) return true;
  }
  return false;
}

// Plain text of a node list (for image alt text): formatting is dropped,
// nested images contribute their alt, HTML contributes nothing.
function plainTextOf(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.t === 'text' || node.t === 'code') out += node.s;
    else if (node.t === 'link') out += node.bare ? node.display : plainTextOf(node.c);
    else if (node.t === 'img') out += node.alt;
    else if (node.t === 'br') out += '\n';
    else if (node.c) out += plainTextOf(node.c);
  }
  return out;
}

// Truncate a bare URL at the first unmatched '(' (an opening paren with
// no matching ')' after it).
function truncateUnmatchedParen(u) {
  const stack = [];
  for (let i = 0; i < u.length; i++) {
    if (u[i] === '(') stack.push(i);
    else if (u[i] === ')') { if (stack.length > 0) stack.pop(); }
  }
  if (stack.length > 0) return u.slice(0, stack[0]);
  return u;
}

// Trim a bare URL's trailing characters per the GFM autolink rules,
// repeating until stable: a trailing ')' is removed while the paren
// depth is negative; a trailing '&name;' is removed as a unit; trailing
// punctuation .,;:?!~*_'" is removed. '-', '/', '=', '#', '+', '%', '&'
// and backtick are kept.
function trimBareUrl(u) {
  u = truncateUnmatchedParen(u);
  let changed = true;
  while (changed && u.length > 0) {
    changed = false;
    const last = u[u.length - 1];
    if (last === ')') {
      // Remove a trailing ')' only if it is unmatched: scan with a
      // stack, so a ')' that pairs with an earlier '(' stays (e.g.
      // the final ')' of 'u)](./docs/create.md)' pairs with the '('
      // before './docs', even though an earlier ')' is unmatched).
      const stack = [];
      let matched = false;
      for (let i = 0; i < u.length; i++) {
        if (u[i] === '(') stack.push(i);
        else if (u[i] === ')') {
          if (stack.length > 0) {
            if (i === u.length - 1) matched = true;
            stack.pop();
          }
        }
      }
      if (!matched) { u = u.slice(0, -1); changed = true; continue; }
    }
    if (last === ';') {
      const m = /&[A-Za-z0-9_]+;$/.exec(u);
      if (m) { u = u.slice(0, u.length - m[0].length); changed = true; continue; }
    }
    if ('.,;:?!~*_\'"'.includes(last)) { u = u.slice(0, -1); changed = true; continue; }
  }
  return u;
}

// Match a bare scheme URL starting at src[i] ('http://', 'https://',
// 'ftp://', case-insensitive scheme). No preceding-char requirement.
// Returns the URL or null.
function matchBareScheme(src, i) {
  const rest = src.slice(i);
  const m = /^(?:https?|ftp):\/\/[A-Za-z0-9-][^\s<]*/i.exec(rest);
  if (!m) return null;
  const url = trimBareUrl(m[0]);
  return url.length > 0 ? url : null;
}

// Match a bare www. URL starting at src[i] (lowercase 'www.' only).
// The preceding char must be start-of-text, whitespace, '(', '*', '_',
// '~', or a token boundary (afterToken). Returns the URL or null.
function matchBareWww(src, i, afterToken, prevChar) {
  if (src.slice(i, i + 4) !== 'www.') return null;
  const allowed = prevChar === null || isUnicodeSpace(prevChar) ||
    prevChar === '(' || prevChar === '*' || prevChar === '_' || prevChar === '~' ||
    afterToken;
  if (!allowed) return null;
  const first = src[i + 4];
  if (!first || !/[A-Za-z0-9-]/.test(first)) return null;
  let j = i;
  while (j < src.length && !isUnicodeSpace(src[j]) && src[j] !== '<') j++;
  const url = trimBareUrl(src.slice(i, j));
  return url.length > 0 ? url : null;
}

// Try a bare email whose '@' is at src[i]. textBuf/textStart describe
// the current text run (for the local-part lookback). Returns
// { email, end, bufOff } (bufOff = the local part's offset in textBuf)
// or null. Local part: [A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+ (RFC atext
// minus '*', '~', '!', '&', backtick). Domain: labels [A-Za-z0-9_-]+
// separated by '.', at least one dot, the final label ending in an alnum.
function matchBareEmail(src, i, textBuf, textStart, hasUnderscoreOpener) {
  if (textBuf.length === 0) return null;
  const n = src.length;
  let localStart = i;
  while (localStart > textStart) {
    const ch = src[localStart - 1];
    // A backslash escape in the local part breaks the match entirely
    // (an escaped char is not part of a bare email address).
    if (ch === '\\') return null;
    if (!/[A-Za-z0-9.!#$%'+\/=?^_{}|-]/.test(ch)) break;
    localStart--;
  }
  if (localStart === i) return null;
  const bufOff = (localStart - textStart) - countEscapesIn(src, textStart, localStart);
  let j = i + 1;
  let labels = 0;
  let lastLabelEnd = -1;
  while (j < n) {
    let k = j;
    while (k < n && /[A-Za-z0-9_-]/.test(src[k])) k++;
    if (k === j) break;
    labels++;
    lastLabelEnd = k;
    j = k;
    if (src[j] === '.') { j++; continue; }
    break;
  }
  if (labels < 2) return null;
  // The final label must end in an alnum. A trailing run of _ or -
  // is trimmed when it is 2+ long (an emphasis delimiter, e.g. the
  // __ closer of a strong); a single trailing _ is trimmed only when
  // an unmatched _ opener precedes it in this paragraph (so it is an
  // emphasis closer); a single trailing _ or - with no opener rejects
  // the whole email. The trimmed label must still end in an alnum.
  const lastCh = src[lastLabelEnd - 1];
  if (lastCh === '_' || lastCh === '-') {
    let s = lastLabelEnd;
    while (s > 0 && src[s - 1] === lastCh) s--;
    if (lastLabelEnd - s >= 2 || (lastCh === '_' && hasUnderscoreOpener)) {
      lastLabelEnd = s;
      if (!/[A-Za-z0-9]/.test(src[lastLabelEnd - 1])) return null;
    } else {
      return null;
    }
  }
  const email = src.slice(localStart, lastLabelEnd);
  return { email, end: lastLabelEnd, bufOff };
}

// Match a bare mailto: or xmpp: link starting at src[i] (lowercase
// prefix only). mailto: takes an email and no path; xmpp: takes an email
// plus at most one resource segment [A-Za-z0-9.@]+ (trailing '.' trimmed).
// Returns { url, end } or null.
function matchBareMailtoXmpp(src, i, afterToken, prevChar) {
  const allowed = prevChar === null || isUnicodeSpace(prevChar) ||
    prevChar === '(' || prevChar === '*' || prevChar === '_' || prevChar === '~' ||
    afterToken;
  if (!allowed) return null;
  let prefix = null;
  if (src.slice(i, i + 7) === 'mailto:') prefix = 'mailto:';
  else if (src.slice(i, i + 5) === 'xmpp:') prefix = 'xmpp:';
  else return null;
  const emailStart = i + prefix.length;
  const emailM = /^([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)/.exec(src.slice(emailStart));
  if (!emailM) return null;
  let url = prefix + emailM[1];
  let end = emailStart + emailM[1].length;
  // A domain label ending in '-' or '_' rejects the whole address
  // (the regex above stops before the trailing '-'/'_', so check it).
  if (src[end] === '-' || src[end] === '_') return null;
  if (prefix === 'xmpp:' && src[end] === '/') {
    let k = end + 1;
    while (k < src.length && /[A-Za-z0-9.@]/.test(src[k])) k++;
    const resource = src.slice(end + 1, k).replace(/[.,]+$/, '');
    if (resource.length > 0) {
      url += '/' + resource;
      end = end + 1 + resource.length;
    }
  }
  return { url, end };
}

// Scan inline content into a node array. refs maps normalized labels to
// { dest, title }.
function scanInline(src, refs) {
  const nodes = [];
  const n = src.length;
  let i = 0;
  let textBuf = '';
  let textStart = 0;
  // True right after a link/image/code/html/autolink node (for www.).
  let afterToken = false;
  // Source index before which '*'/'_'/'~' runs are plain text (not
  // delimiters): set when a link fails after its label was scanned
  // (the label text was consumed by the failed link attempt, so its
  // emphasis does not form).
  let noDelimEnd = -1;
  // Set once a link/image whose label held a broken code span has
  // formed in this inline content. After such a link, marked
  // suppresses an emphasis/strikethrough delimiter run when a
  // backtick follows it later in the same inline content (the
  // broken code span in the label leaves the emphasis unformed);
  // a delimiter with no backtick after it still forms (doc-06).
  let brokenLabelSeen = false;
  // Index of the last backtick in this inline content (-1 if none):
  // a delimiter at i has a backtick after it iff i < lastTick.
  const lastTick = src.lastIndexOf('`');

  function flushText() {
    if (textBuf.length > 0) {
      nodes.push({ t: 'text', s: textBuf });
      textBuf = '';
    }
    afterToken = false;
  }
  function addChar(c, srcIdx) {
    if (textBuf.length === 0) textStart = srcIdx;
    textBuf += c;
    afterToken = false;
  }
  function pushNode(node) {
    flushText();
    nodes.push(node);
    afterToken = true;
  }

  while (i < n) {
    const c = src[i];

    // Backslash escapes and hard breaks.
    if (c === '\\') {
      if (i + 1 < n && isAsciiPunct(src[i + 1])) {
        const e = src[i + 1];
        if (e === '&') {
          // A backslash-escaped '&' is a literal '&', not the start of
          // an entity: keep it in its own text node so the entity check
          // cannot join it with the following text.
          flushText();
          nodes.push({ t: 'text', s: '&' });
          afterToken = false;
        } else {
          addChar(e, i);
        }
        i += 2;
        continue;
      }
      if (src[i + 1] === '\n') {
        // Hard break: spaces before the backslash are kept. Leading
        // spaces/tabs on the next line are stripped.
        pushNode({ t: 'br' });
        i += 2;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      addChar('\\', i);
      i++;
      continue;
    }

    // Newline: a hard break is two or more spaces before it (the spaces
    // are removed); otherwise a soft break (kept as '\n'). After a hard
    // break, leading spaces/tabs on the next line are stripped.
    if (c === '\n') {
      let sp = 0;
      let k = textBuf.length - 1;
      while (k >= 0 && textBuf[k] === ' ') { sp++; k--; }
      if (sp >= 2) {
        textBuf = textBuf.slice(0, textBuf.length - sp);
        pushNode({ t: 'br' });
        i++;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
      } else {
        addChar('\n', i);
        i++;
      }
      continue;
    }

    // Code span.
    if (c === '`') {
      const cs = scanCodeSpan(src, i);
      if (cs) {
        pushNode({ t: 'code', s: cs.text });
        i = cs.end;
        continue;
      }
      // No matching closer: the whole backtick run is literal text (a
      // shorter run must not start inside it).
      let j = i;
      while (j < n && src[j] === '`') j++;
      for (let k = i; k < j; k++) addChar('`', k);
      i = j;
      continue;
    }

    // Emphasis / strikethrough delimiter runs.
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && src[j] === c) j++;
      // Inside a failed link label, delimiter runs are plain text.
      if (i < noDelimEnd) {
        for (let k = i; k < j; k++) addChar(src[k], k);
        i = j;
        continue;
      }
      // After a link/image whose label held a broken code span, a
      // delimiter run with a backtick later in this inline content
      // is plain text (marked suppresses it); one with no backtick
      // after it still forms.
      if (brokenLabelSeen && i < lastTick) {
        for (let k = i; k < j; k++) addChar(src[k], k);
        i = j;
        continue;
      }
      const run = j - i;
      const afterCh = j < n ? src[j] : null;
      const beforeCh = i > 0 ? src[i - 1] : null;
      // Start/end of string count as whitespace for flanking.
      const afterIsWs = afterCh === null || isUnicodeSpace(afterCh);
      const beforeIsWs = beforeCh === null || isUnicodeSpace(beforeCh);
      const afterIsPunct = afterCh !== null && isPunct(afterCh);
      const beforeIsPunct = beforeCh !== null && isPunct(beforeCh);
      // CommonMark flanking: left-flanking needs a non-space after, and
      // either a non-punctuation after or a space/punctuation before;
      // right-flanking is the mirror image.
      const leftFlank = !afterIsWs && (!afterIsPunct || beforeIsWs || beforeIsPunct);
      const rightFlank = !beforeIsWs && (!beforeIsPunct || afterIsWs || afterIsPunct);
      let canOpen, canClose;
      if (c === '_') {
        canOpen = leftFlank && (!rightFlank || (beforeCh !== null && isPunct(beforeCh)));
        canClose = rightFlank && (!leftFlank || (afterCh !== null && isPunct(afterCh)));
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      // A run that can neither open nor close is inert: keep it as plain
      // text so it does not fragment the text run (a bare-email lookback
      // must be able to see past an intraword '_').
      if (!canOpen && !canClose) {
        for (let k = i; k < j; k++) addChar(src[k], k);
        i = j;
        continue;
      }
      pushNode({ t: 'delim', ch: c, n: run, canOpen, canClose });
      i = j;
      continue;
    }

    // Links and images.
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const isImage = c === '!';
      const labelStart = isImage ? i + 1 : i;
      // The first label allows nested brackets (it may contain an image
      // or nested brackets as text); only a link inside it blocks the
      // link. The HTML-tag quote check applies to link labels only.
      const lab = scanLabel(src, labelStart, true, !isImage);
      if (lab) {
        // A label invalidated by a backtick-containing code span does
        // not form a link, and the emphasis inside it does not form
        // either (the label was consumed by the failed link attempt).
        if (lab.badCodeSpan) noDelimEnd = lab.end;
        let link = null;
        let end = -1;
        if (!lab.badCodeSpan && src[lab.end] === '(') {
          const inl = tryInlineLink(src, lab.end);
          if (inl) { link = inl; end = inl.end; }
          else {
            const sc = tryShortcut(lab.text, refs);
            if (sc) { link = sc; end = lab.end; }
          }
        } else if (!lab.badCodeSpan && src[lab.end] === '[') {
          const rf = tryRefLink(src, lab.text, lab.end, refs);
          if (rf) { link = rf; end = rf.end; }
        } else if (!lab.badCodeSpan) {
          const sc = tryShortcut(lab.text, refs);
          if (sc) { link = sc; end = lab.end; }
        }
        if (link) {
          const labelNodes = resolveDelims(scanInline(lab.text, refs));
          // A link label must not contain a link; an image label may
          // (it is flattened to alt text).
          if (isImage || !containsLink(labelNodes)) {
            if (lab.codeSpanBroken) brokenLabelSeen = true;
            if (isImage) {
              pushNode({ t: 'img', src: link.dest, alt: plainTextOf(labelNodes), title: link.title });
            } else {
              pushNode({ t: 'link', href: link.dest, title: link.title, c: labelNodes });
            }
            i = end;
            continue;
          }
          // The label contains a link: not a link/image. Fall through.
        }
      }
      addChar(c, i);
      i++;
      continue;
    }

    // Inline HTML and bracket autolinks.
    if (c === '<') {
      const tag = tryHtmlTag(src, i);
      if (tag) {
        // An opening <a> tag in inline content suppresses bare
        // An unclosed <a> suppresses bare autolinks document-wide
        // until a </a>; a closing </a> clears it. Bracket
        // autolinks and explicit links are unaffected. Any <a...>
        // opening tag sets the flag, even a self-closing <a />.
        if (tag.node.t === 'html') {
          const ts = tag.node.s;
          if (/^<\/a[\s>]/.test(ts)) inATag = false;
          else if (/^<a[\s>]/.test(ts)) inATag = true;
        }
        pushNode(tag.node);
        i = tag.end;
        continue;
      }
      addChar('<', i);
      i++;
      continue;
    }

    // Bare mailto:/xmpp: links (suppressed inside an unclosed <a>).
    if (c === 'm' || c === 'x') {
      const m = !inATag && matchBareMailtoXmpp(src, i, afterToken, i === 0 ? null : src[i - 1]);
      if (m) {
        pushNode({ t: 'link', href: m.url, display: m.url, bare: true });
        i += m.url.length;
        continue;
      }
      addChar(c, i);
      i++;
      continue;
    }

    // Bare scheme URLs (suppressed inside an unclosed <a>).
    if (c === 'h' || c === 'H' || c === 'f' || c === 'F') {
      const url = !inATag && matchBareScheme(src, i);
      if (url) {
        pushNode({ t: 'link', href: url, display: url, bare: true });
        i += url.length;
        continue;
      }
      addChar(c, i);
      i++;
      continue;
    }

    // Bare www. URLs (suppressed inside an unclosed <a>).
    if (c === 'w' || c === 'W') {
      const url = !inATag && matchBareWww(src, i, afterToken, i === 0 ? null : src[i - 1]);
      if (url) {
        pushNode({ t: 'link', href: 'http://' + url, display: url, bare: true });
        i += url.length;
        continue;
      }
      addChar(c, i);
      i++;
      continue;
    }

    // Bare email (looked up at the '@'; suppressed inside an <a>).
    if (c === '@') {
      // A single trailing _ after the domain is an emphasis closer
      // only when an unmatched _ opener precedes it in this paragraph.
      let hasUnderscoreOpener = false;
      for (let q = 0; q < nodes.length; q++) {
        const nd = nodes[q];
        if (nd.t === 'delim' && nd.ch === '_' && nd.canOpen) { hasUnderscoreOpener = true; break; }
      }
      const em = !inATag && matchBareEmail(src, i, textBuf, textStart, hasUnderscoreOpener);
      if (em) {
        const before = textBuf.slice(0, em.bufOff);
        if (before.length > 0) nodes.push({ t: 'text', s: before });
        textBuf = '';
        nodes.push({ t: 'link', href: 'mailto:' + em.email, display: em.email, bare: true });
        afterToken = true;
        i = em.end;
        continue;
      }
      addChar('@', i);
      i++;
      continue;
    }

    addChar(c, i);
    i++;
  }

  flushText();
  return nodes;
}

// ------------------------------------------------------------ emphasis

// The rule of 3: skip an opener when one of the two runs can both open
// and close, the sum of the run lengths is a multiple of 3, and the two
// runs are not both multiples of 3.
function oddMatch(opener, closer) {
  return (opener.canClose || closer.canOpen) &&
    ((opener.n + closer.n) % 3 === 0) &&
    (opener.n % 3 !== 0 || closer.n % 3 !== 0);
}

// Resolve emphasis delimiters in a node array (CommonMark delimiter-stack
// algorithm). Returns a new node array with em/strong/del nodes.
function resolveDelims(nodes) {
  let head = null;
  let tail = null;
  let seq = 0;
  for (const node of nodes) {
    const w = { node, prev: tail, next: null, seq: seq++ };
    if (tail) tail.next = w;
    else head = w;
    tail = w;
  }
  const stacks = new Map();
  // openers_bottom: for each delimiter char, the sequence number of the
  // opener below which no opener may match (CommonMark). It is set when
  // emphasis is created and the closer can open or the opener can
  // close, and cleared when a closer finds no opener at all.
  const bottom = new Map();
  // The most recently created emphasis node (for the leftover rule).
  let lastEmNode = null;
  function stackFor(ch) {
    let st = stacks.get(ch);
    if (!st) { st = []; stacks.set(ch, st); }
    return st;
  }
  function removeFromStack(w) {
    const st = stacks.get(w.node.ch);
    if (!st) return;
    const idx = st.indexOf(w);
    if (idx !== -1) st.splice(idx, 1);
  }
  function findOpener(closerW) {
    const closer = closerW.node;
    const st = stacks.get(closer.ch);
    if (!st) { bottom.delete(closer.ch); return null; }
    const isTilde = closer.ch === '~';
    const b = bottom.get(closer.ch);
    let blocked = false;
    for (let k = st.length - 1; k >= 0; k--) {
      const o = st[k];
      if (b !== undefined && o.seq <= b.seq) {
        // openers_bottom: past a strong, only a full **-on-** match
        // is allowed (a single closer, or a ** closer on a single
        // opener, would only partly consume and is blocked); past an
        // em, only a match that would partly consume the opener is
        // blocked. A blocked opener is skipped, not fatal: an older
        // opener may still match (the block depends on the match).
        // A blocked lookup does NOT clear the bottom, so a later
        // closer is still barred from the same openers.
        if (b.strong ? !(closer.n === 2 && o.node.n === 2) : o.node.n > closer.n) { blocked = true; continue; }
      }
      // An emphasis cannot be empty: opener and closer must not be
      // adjacent in the list.
      if (o.next === closerW) continue;
      if (isTilde) {
        // Strikethrough matches only equal runs of 1 or 2, no rule of 3.
        if (o.node.n !== closer.n || o.node.n > 2) continue;
      } else if (oddMatch(o.node, closer)) continue;
      return o;
    }
    if (!blocked) bottom.delete(closer.ch);
    return null;
  }
  function makeEmphasis(openerW, closerW) {
    const opener = openerW.node;
    const closer = closerW.node;
    const ch = opener.ch;
    let useDelims;
    let kind;
    if (ch === '~') {
      useDelims = opener.n;
      kind = 'del';
    } else if (opener.n >= 2 && closer.n >= 2) {
      useDelims = 2;
      kind = 'strong';
    } else {
      useDelims = 1;
      kind = 'em';
    }
    // Collect the nodes between opener and closer as the new node's
    // children. Delimiters inside it can no longer match outside it.
    const children = [];
    let x = openerW.next;
    while (x !== closerW) {
      children.push(x.node);
      if (x.node.t === 'delim') removeFromStack(x);
      x = x.next;
    }
    const emNode = { t: kind, c: children };
    lastEmNode = emNode;
    const emW = { node: emNode, prev: openerW, next: closerW };
    openerW.next = emW;
    closerW.prev = emW;
    opener.n -= useDelims;
    closer.n -= useDelims;
    // openers_bottom: if the closer can open but the opener cannot
    // close, no opener at or before this one may match a later closer
    // (subject to the strong / partial-consume rules in findOpener).
    // Record whether the emphasis just made was a strong. This only
    // applies when the closer was fully consumed; a partially
    // consumed closer keeps matching with its leftover, unblocked.
    if (closer.n === 0 && closer.canOpen && !opener.canClose) bottom.set(ch, { seq: openerW.seq, strong: useDelims === 2 });
    if (opener.n === 0) {
      removeFromStack(openerW);
      const p = openerW.prev;
      if (p) p.next = emW;
      else head = emW;
      emW.prev = p;
    }
    if (closer.n === 0) {
      const nx = closerW.next;
      if (nx) nx.prev = emW;
      else tail = emW;
      emW.next = nx;
    }
  }

  let w = head;
  while (w) {
    const node = w.node;
    const next = w.next;
    if (node.t === 'delim') {
      if (node.canClose) {
        const startN = node.n;
        while (node.n > 0 && node.canClose) {
          const opener = findOpener(w);
          if (!opener) break;
          makeEmphasis(opener, w);
        }
        // A partially-consumed closer with no opener left, that cannot
        // open itself, has its leftover rendered inside the strong it
        // just closed — but only when that strong contains a nested
        // emphasis (e.g. the trailing '*' of '***' in '**a *b*c***'
        // stays inside the <strong>, while in '**foo***' the leftover
        // '*' stays outside, and an <em>'s leftover stays outside).
        if (node.n > 0 && node.n < startN && !node.canOpen && lastEmNode &&
            lastEmNode.t === 'strong' &&
            lastEmNode.c.some((ch) => ch.t === 'em' || ch.t === 'strong' || ch.t === 'del')) {
          lastEmNode.c.push({ t: 'text', s: node.ch.repeat(node.n) });
          node.n = 0;
          removeFromStack(w);
          const p = w.prev;
          const nx = w.next;
          if (p) p.next = nx;
          else head = nx;
          if (nx) nx.prev = p;
          else tail = p;
        }
      }
      if (node.n > 0 && node.canOpen) stackFor(node.ch).push(w);
    }
    w = next;
  }
  const out = [];
  for (let x = head; x; x = x.next) out.push(x.node);
  return out;
}

// Render inline content (a paragraph/heading/cell source string) to HTML.
function renderInline(text, refs) {
  return renderInlineNodes(resolveDelims(scanInline(text, refs)));
}

// Render a resolved inline node array to HTML.
function renderInlineNodes(nodes, inLink = false) {
  let out = '';
  for (const node of nodes) {
    if (node.t === 'text') out += escTextWithEntities(node.s);
    else if (node.t === 'code') out += '<code>' + escText(node.s) + '</code>';
    else if (node.t === 'em') out += '<em>' + renderInlineNodes(node.c, inLink) + '</em>';
    else if (node.t === 'strong') out += '<strong>' + renderInlineNodes(node.c, inLink) + '</strong>';
    else if (node.t === 'del') out += '<del>' + renderInlineNodes(node.c, inLink) + '</del>';
    else if (node.t === 'link') {
      if (node.bare) {
        // A bare URL inside a link label renders as plain text, not a
        // nested link (doc-01). A bracket autolink <...> inside a label
        // still renders as a nested link (doc-03).
        if (inLink && !node.bracket) out += escText(node.display);
        else out += '<a href="' + escBareHref(node.href) + '">' + escText(node.display) + '</a>';
      } else {
        out += '<a href="' + escHref(node.href) + '"';
        if (node.title !== null && node.title !== '') out += ' title="' + escAttr(node.title) + '"';
        out += '>' + renderInlineNodes(node.c, true) + '</a>';
      }
    } else if (node.t === 'img') {
      out += '<img src="' + escHref(node.src) + '" alt="' + escAttr(node.alt) + '"';
      if (node.title !== null && node.title !== '') out += ' title="' + escAttr(node.title) + '"';
      out += '>';
    } else if (node.t === 'html') out += node.s;
    else if (node.t === 'br') out += '<br>';
    else if (node.t === 'delim') out += node.ch.repeat(node.n);
  }
  return out;
}

// ------------------------------------------------------------ block rendering

function renderDoc(root, refs) {
  let out = '';
  for (const child of root.c) out += renderBlock(child, refs);
  return out;
}

function renderBlock(node, refs) {
  switch (node.t) {
    case 'para':
      return '<p>' + renderInline(node.text, refs) + '</p>\n';
    case 'heading':
      return '<h' + node.level + '>' + renderInline(node.text, refs) + '</h' + node.level + '>\n';
    case 'code': {
      let text = node.text;
      if (node.fenced) {
        // Strip exactly one trailing newline when the last content line
        // is blank.
        if (text.endsWith('\n\n') || text === '\n') text = text.slice(0, -1);
      } else {
        // Indented code loses all trailing blank lines.
        text = text.replace(/\n+$/, '\n');
      }
      let cls = '';
      if (node.fenced && node.info) {
        const word = node.info.split(/[ \t]/)[0];
        if (word) cls = ' class="language-' + escAttr(word) + '"';
      }
      return '<pre><code' + cls + '>' + escText(text) + '</code></pre>\n';
    }
    case 'html':
      return node.text;
    case 'quote': {
      let out = '<blockquote>\n';
      for (const child of node.c) out += renderBlock(child, refs);
      return out + '</blockquote>\n';
    }
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      let open = '<' + tag;
      if (node.ordered && node.start !== 1) open += ' start="' + node.start + '"';
      open += '>\n';
      let out = open;
      for (const item of node.c) out += renderItem(item, node.tight, refs);
      return out + '</' + tag + '>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < node.head.length; k++) {
        const a = node.align[k];
        out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(node.head[k], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rows.length > 0) {
        out += '<tbody>';
        for (const row of node.rows) {
          out += '<tr>\n';
          for (let k = 0; k < node.head.length; k++) {
            const cell = k < row.length ? row[k] : '';
            const a = node.align[k];
            out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(cell, refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody></table>\n';
      } else {
        out += '</table>\n';
      }
      return out;
    }
    case 'hr':
      return '<hr>\n';
    default:
      return '';
  }
}

// Render one list item. In a tight list every paragraph renders
// unwrapped; in a loose list every paragraph is wrapped in <p>. A
// task-list checkbox belongs to the first paragraph's inline content:
// only the 3-char marker is stripped, the following space stays as text.
function renderItem(item, tight, refs) {
  let out = '<li>';
  const children = item.c;
  let taskHtml = '';
  let firstTextOverride = null;
  if (children.length > 0 && children[0].t === 'para') {
    const text = children[0].text;
    const m = /^\[( |x|X)\](?:[ \t\n]|$)/.exec(text);
    if (m) {
      const checked = m[1] === 'x' || m[1] === 'X';
      taskHtml = checked
        ? '<input checked="" disabled="" type="checkbox">'
        : '<input disabled="" type="checkbox">';
      firstTextOverride = text.slice(3);
    }
  }
  for (let k = 0; k < children.length; k++) {
    const child = children[k];
    if (child.t === 'para') {
      const inline = renderInline(
        k === 0 && firstTextOverride !== null ? firstTextOverride : child.text,
        refs,
      );
      if (tight) out += (k === 0 ? taskHtml : '') + inline;
      else out += '<p>' + (k === 0 ? taskHtml : '') + inline + '</p>\n';
    } else {
      out += renderBlock(child, refs);
    }
  }
  return out + '</li>\n';
}

export function parse(markdown) {
  inATag = false;
  const { root, refs } = parseBlocks(markdown);
  let out = renderDoc(root, refs);
  // A document whose last block is raw HTML (directly, or as the last
  // descendant of a container) ends with a newline only if the input
  // does (gfm-657); every other block type always ends with one.
  if (markdown.length > 0 && !markdown.endsWith('\n') && out.endsWith('\n') && lastBlockIsHtml(root)) {
    out = out.slice(0, -1);
  }
  return out;
}

// Is the document's last block (recursing into containers) an HTML block?
function lastBlockIsHtml(node) {
  if (!node.c || node.c.length === 0) return node.t === 'html';
  return lastBlockIsHtml(node.c[node.c.length - 1]);
}
