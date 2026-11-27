// Fast line diff: an exact drop-in for makefun-diff 1.0.0's diffPatch.
//
// Strategy (my own implementation of the spec in the kit's RULES.txt):
//  1. Tokenize each text into lines (cut after every "\n"; a last line with no
//     "\n" is a line too) as slices of the original string (no copying), and
//     intern every distinct line through one shared Map, so a line becomes a
//     small integer id and line equality is one integer compare.
//  2. Strip the common prefix, then the common suffix, of the id arrays.
//  3. Myers's greedy search on the middle, with the make.fun tie-break
//     (deletion preferred when a deletion and an insertion reach the same
//     point into the old text) and no edge pruning. Instead of the reference's
//     linked-list path objects (one allocation per (d, k) plus one per snake
//     step), keep one Int32Array V per d holding the furthest x reached on
//     each diagonal (stored as x + 1, so 0 means unreachable and a fresh array
//     needs no fill), then backtrack from the end to recover the edit script.
//  4. Format the patch exactly as the spec says: header line, hunks with up
//     to 3 kept lines of context, runs at most 6 kept lines apart sharing a
//     hunk, "%" after a line that ends its text with no newline.

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** Split `text` into lines (each keeping its "\n", the last one without when the text does not end in one). */
function tokenize(text, intern, ids, lines) {
  const len = text.length;
  let start = 0;
  while (start < len) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) {
      const line = text.slice(start);
      lines.push(line);
      let id = intern.get(line);
      if (id === undefined) { id = intern.size; intern.set(line, id); }
      ids.push(id);
      break;
    }
    const line = text.slice(start, nl + 1);
    lines.push(line);
    let id = intern.get(line);
    if (id === undefined) { id = intern.size; intern.set(line, id); }
    ids.push(id);
    start = nl + 1;
  }
}

/**
 * The edit script of a[off..off+n) into b[off..off+m), as merged runs
 * [{ kind, count }] in order, kinds KEEP/DELETE/INSERT.
 * Myers's greedy search, deletion preferred on ties, no edge pruning.
 */
function editRuns(aArr, aOff, n, bArr, bOff, m) {
  if (n === 0 && m === 0) return [];
  // Vs[d] is an Int32Array of length 2d+1; Vs[d][k + d] holds the furthest x
  // (old lines consumed) reached on diagonal k after d edits and its snake,
  // stored as x + 1, or 0 when the diagonal is unreachable at that d.
  const Vs = [];
  const v0 = new Int32Array(1);
  let x = 0;
  while (x < n && x < m && aArr[aOff + x] === bArr[bOff + x]) x++;
  v0[0] = x + 1;
  Vs.push(v0);
  let D = 0;
  let K = 0;
  if (x >= n && x >= m) {
    return x > 0 ? [{ kind: KEEP, count: x }] : [];
  }
  outer: for (let d = 1; d <= n + m; d++) {
    const v = new Int32Array(2 * d + 1);
    const prev = Vs[d - 1];
    const prevLen = prev.length;
    for (let k = -d; k <= d; k += 2) {
      const delIdx = k + d - 2; // prev index of diagonal k-1
      const insIdx = k + d;     // prev index of diagonal k+1
      let xDel = -1;
      let xIns = -1;
      // A deletion is a candidate only while an old line is left to delete.
      if (delIdx >= 0 && delIdx < prevLen) {
        const xp = prev[delIdx];
        if (xp > 0 && xp - 1 < n) xDel = xp;
      }
      // An insertion is a candidate only while a new line is left to insert:
      // y on diagonal k+1 is xp - 1 - (k+1), and it must be < m.
      if (insIdx >= 0 && insIdx < prevLen) {
        const xp = prev[insIdx];
        if (xp > 0 && xp - 1 - (k + 1) < m) xIns = xp - 1;
      }
      if (xDel < 0 && xIns < 0) continue;
      // Deletion wins ties (xDel >= xIns), as the spec requires. Note the
      // stored values are x + 1, so xDel/xIns here are already the post-edit
      // x of each candidate (deletion's xp, insertion's xp - 1).
      let xx = xDel >= xIns ? xDel : xIns;
      let y = xx - k;
      // Snake: follow every run of lines equal in both as far as it goes.
      while (xx < n && y < m && aArr[aOff + xx] === bArr[bOff + y]) { xx++; y++; }
      v[k + d] = xx + 1;
      if (xx >= n && y >= m) { D = d; K = k; Vs.push(v); break outer; }
    }
    Vs.push(v);
  }

  // Backtrack from (D, K, x = n) to recover the script, collecting runs in reverse.
  const rev = [];
  let xx = n;
  let k = K;
  for (let d = D; d >= 1; d--) {
    const prev = Vs[d - 1];
    const prevLen = prev.length;
    const delIdx = k + d - 2;
    const insIdx = k + d;
    let xDel = -1;
    let xIns = -1;
    if (delIdx >= 0 && delIdx < prevLen) {
      const xp = prev[delIdx];
      if (xp > 0 && xp - 1 < n) xDel = xp;
    }
    if (insIdx >= 0 && insIdx < prevLen) {
      const xp = prev[insIdx];
      if (xp > 0 && xp - 1 - (k + 1) < m) xIns = xp - 1;
    }
    const isDel = xDel >= xIns;
    const xPrev = isDel ? xDel : xIns; // point after the edit, before the snake
    const snake = xx - xPrev;
    if (snake > 0) rev.push({ kind: KEEP, count: snake });
    rev.push({ kind: isDel ? DELETE : INSERT, count: 1 });
    if (isDel) { xx = xPrev - 1; k = k - 1; } else { xx = xPrev; k = k + 1; }
  }
  if (xx > 0) rev.push({ kind: KEEP, count: xx });
  rev.reverse();
  // Merge adjacent runs of one kind (a snake of length 0 leaves two edits adjacent).
  const runs = [];
  for (const r of rev) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === r.kind) last.count += r.count;
    else runs.push({ kind: r.kind, count: r.count });
  }
  return runs;
}

/** Count a text's lines without interning (identical-text fast path). */
function tokenizeCount(text) {
  if (text.length === 0) return 0;
  let count = 0;
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) { count++; break; }
    count++;
    start = nl + 1;
  }
  return count;
}

/** makefun-diff 1.0.0's answer for one case's input { old, new }: its patch, as one JSON string. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const oldText = input.old;
  const newText = input.new;
  // Fast path: identical texts are the header alone.
  if (oldText === newText) {
    const n = tokenizeCount(oldText);
    return `makefun-diff/1 old=${n} new=${n} hunks=0 deleted=0 inserted=0\n`;
  }
  const intern = new Map();
  const aIds = [];
  const aLines = [];
  const bIds = [];
  const bLines = [];
  tokenize(oldText, intern, aIds, aLines);
  tokenize(newText, intern, bIds, bLines);
  const n = aIds.length;
  const m = bIds.length;

  // Common prefix, then common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && aIds[prefix] === bIds[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && aIds[n - 1 - suffix] === bIds[m - 1 - suffix]) suffix++;
  const midN = n - prefix - suffix;
  const midM = m - prefix - suffix;
  // Work on views of the id arrays to avoid copying the middle out.
  const midRuns = editRuns(aIds, prefix, midN, bIds, prefix, midM);

  // Full run list: prefix keeps, middle runs, suffix keeps.
  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  for (const r of midRuns) runs.push(r);
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  // The change runs: each a stretch of deletions and insertions between two kept lines.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) { o += r.count; p += r.count; continue; }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) { c.dels += r.count; o += r.count; deleted += r.count; }
    else { c.ins += r.count; p += r.count; inserted += r.count; }
  }

  // Hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const CONTEXT = 3;
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) {
        const line = aLines[at];
        if (line.charCodeAt(line.length - 1) === 10) out.push('=', line);
        else out.push('=', line, '\n%\n');
      }
      for (let i = 0; i < c.dels; i++) {
        const line = aLines[c.o + i];
        if (line.charCodeAt(line.length - 1) === 10) out.push('-', line);
        else out.push('-', line, '\n%\n');
      }
      for (let i = 0; i < c.ins; i++) {
        const line = bLines[c.p + i];
        if (line.charCodeAt(line.length - 1) === 10) out.push('+', line);
        else out.push('+', line, '\n%\n');
      }
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) {
      const line = aLines[at];
      if (line.charCodeAt(line.length - 1) === 10) out.push('=', line);
      else out.push('=', line, '\n%\n');
    }
  }
  return out.join('');
}
