/**
 * Line diff used to display the agent's changes.
 * Implements LCS (Longest Common Subsequence) with no external dependencies.
 */

const MAX_LINES_FOR_LCS = 2500;

/**
 * Compare two texts and return each line tagged with its kind.
 * @returns {{lines: Array<{type:"add"|"del"|"ctx", text:string, oldNo:number|null, newNo:number|null}>, added:number, removed:number}}
 */
export function diffLines(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // For very large files, skip the LCS matrix (O(n*m) memory).
  if (a.length * b.length > MAX_LINES_FOR_LCS * MAX_LINES_FOR_LCS) {
    return coarseDiff(a, b);
  }

  const table = buildLCSTable(a, b);
  const lines = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ type: "ctx", text: a[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ type: "del", text: a[i], oldNo: i + 1, newNo: null });
      removed++;
      i++;
    } else {
      lines.push({ type: "add", text: b[j], oldNo: null, newNo: j + 1 });
      added++;
      j++;
    }
  }
  while (i < a.length) {
    lines.push({ type: "del", text: a[i], oldNo: i + 1, newNo: null });
    removed++;
    i++;
  }
  while (j < b.length) {
    lines.push({ type: "add", text: b[j], oldNo: null, newNo: j + 1 });
    added++;
    j++;
  }

  return { lines, added, removed };
}

function splitLines(text) {
  const s = String(text ?? "");
  if (s === "") return [];
  return s.replace(/\r\n/g, "\n").split("\n");
}

function buildLCSTable(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

/** Approximate diff for huge files: strip the common prefix and suffix. */
function coarseDiff(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const lines = [];
  for (let i = start; i < endA; i++) {
    lines.push({ type: "del", text: a[i], oldNo: i + 1, newNo: null });
  }
  for (let j = start; j < endB; j++) {
    lines.push({ type: "add", text: b[j], oldNo: null, newNo: j + 1 });
  }
  return { lines, added: endB - start, removed: endA - start };
}

/**
 * Group the diff into hunks with context, dropping unchanged blocks.
 * @returns {Array<Array<line>>}
 */
export function toHunks(lines, context = 2) {
  const changed = [];
  lines.forEach((l, i) => {
    if (l.type !== "ctx") changed.push(i);
  });
  if (changed.length === 0) return [];

  const ranges = [];
  let start = Math.max(0, changed[0] - context);
  let end = Math.min(lines.length - 1, changed[0] + context);

  for (const idx of changed.slice(1)) {
    if (idx - context <= end + 1) {
      end = Math.min(lines.length - 1, idx + context);
    } else {
      ranges.push([start, end]);
      start = Math.max(0, idx - context);
      end = Math.min(lines.length - 1, idx + context);
    }
  }
  ranges.push([start, end]);

  return ranges.map(([s, e]) => lines.slice(s, e + 1));
}

/** Compact summary: "+12 -3" */
export function formatDiffStat(added, removed) {
  const parts = [];
  if (added) parts.push(`+${added}`);
  if (removed) parts.push(`-${removed}`);
  return parts.join(" ") || "no changes";
}
