/**
 * Compaction prompt.
 *
 * When the context fills up we ask the model to write a full handoff for the
 * session. The result replaces the old conversation, so it has to stand on
 * its own: whoever reads it will see nothing that came before.
 *
 * The format is fixed and exhaustive on purpose. A prose summary loses paths,
 * commands and decisions; the sections force them to be kept.
 */

export const COMPACTION_SYSTEM_PROMPT = `You are writing a HANDOFF DOCUMENT for another engineer who will continue this work.

They cannot see any of the previous conversation. Your document is the ONLY thing they will have. If you omit something, it is lost forever and they will repeat work, break things, or contradict decisions already made.

Write in a way that lets them resume mid-task without asking a single question.

CRITICAL RULES:
- Preserve EXACT values: file paths, function names, commands, flags, versions, error strings, URLs, ports, env var names.
- Never write "the file" or "that function". Write the real path and the real name.
- Never write "as discussed" or "as mentioned". Restate the actual content.
- Prefer concrete over abstract. "Changed timeout 30s->120s in src/api.js:42" beats "adjusted timeouts".
- If something was tried and FAILED, say so explicitly and why. Preventing a repeated failure is as valuable as recording a success.
- Do not invent. If you do not know something, write "unknown".
- Include code snippets when the exact shape matters.
- Length is NOT a concern. Completeness is. Be exhaustive.

Output ONLY the document in the exact format given. No preamble, no closing remarks.`;

export const COMPACTION_TEMPLATE = `Write the handoff document using EXACTLY these sections. Keep every heading, even if a section is empty (write "None." in that case).

# 1. ORIGINAL REQUEST
The user's goal in their own words. Quote the literal wording of the core request. If the goal shifted mid-session, state the original goal, the current goal, and exactly what caused the change.

# 2. CURRENT STATE
Where things stand RIGHT NOW:
- Status: COMPLETE | IN PROGRESS | BLOCKED
- What works today (verified)
- What is broken today
- What is half-finished or knowingly left in a bad state
Be blunt. Do not present unfinished work as done.

# 3. MENTAL MODEL OF THE CODEBASE
How this project is organized, as understood so far. The reader has never seen it:
- Purpose of the project and what it does
- Directory layout and what lives where
- Entry points, key modules, and how data flows between them
- The architectural style in use and any patterns to follow
This section prevents the reader from re-exploring the whole tree.

# 4. FILES TOUCHED
Every file read, created, modified, or deleted. One line each:
- \`path/to/file.js\` — CREATED|MODIFIED|DELETED|READ — what changed and why
Include line numbers for important edits. For files only read, state what was learned from them.

# 5. CHANGES MADE
The concrete edits in chronological order. For each: what changed, where, and why. Include short code snippets where the exact form matters (function signatures, config values, regexes, schemas).

# 6. COMMANDS RUN
Every command executed and its outcome:
- \`command\` — exit code / result — what it proved
Include failing commands. Name the tests that pass and fail.

# 7. DECISIONS AND RATIONALE
Every choice made and WHY, including alternatives considered and rejected with the reason. This is the section most often lost and the most expensive to reconstruct. Include:
- Technical decisions (libraries, patterns, data shapes)
- Trade-offs accepted and what they cost
- Explicit user preferences ("use X", "never do Y", naming and style rules)

# 8. WHAT WAS LEARNED
Durable facts about this codebase that are NOT obvious from a fresh read:
- Conventions actually followed (vs. what a newcomer would assume)
- Where things live and how modules relate
- Gotchas, footguns, and surprising behavior
- Versions, tooling, and the build/test commands that actually work
- Environment quirks (OS, runtime, missing tools, network limits)
Rediscovering these costs real time. Write them as standalone facts.

# 9. FAILED ATTEMPTS
Approaches tried that did NOT work, with the exact reason:
- What was tried
- What happened (verbatim error messages)
- Why it failed and whether it is worth revisiting
Explicitly warn against retrying anything already ruled out.

# 10. USER FEEDBACK AND CORRECTIONS
Every time the user corrected, redirected, rejected, or complained. Quote them. These carry the strongest signal about what they actually want and must never be lost.

# 11. OPEN QUESTIONS
Unresolved issues, ambiguities, and anything awaiting a decision. If the user was asked something and has not answered, record the exact question.

# 12. NEXT STEPS
The concrete, ordered plan to continue. Each step actionable on its own:
1. Specific action — in which file — expected result
Mark which step was IN PROGRESS when this document was written, and what the immediate next keystroke should be.

# 13. VERIFICATION
How to confirm the work is correct:
- Exact commands to run and their expected output
- What "done" looks like
- What has NOT been verified yet (be explicit about untested claims)

# 14. CONSTRAINTS AND INVARIANTS
Anything that must not be violated:
- Explicit user instructions
- Files that must not be touched
- Compatibility, style, performance, and security requirements
- Assumptions the code currently relies on

`;

/**
 * Build the messages sent to the model to perform compaction.
 *
 * @param {Array} messages     conversation to summarise
 * @param {object} options     { cwd, model, previousSummary, toolStats }
 */
export function buildCompactionRequest(messages, options = {}) {
  const { cwd, previousSummary, toolStats } = options;

  const transcript = renderTranscript(messages);

  const contextLines = [];
  if (cwd) contextLines.push(`Working directory: ${cwd}`);
  if (toolStats?.total) {
    const breakdown = Object.entries(toolStats.byName || {})
      .map(([n, c]) => `${n}×${c}`)
      .join(", ");
    contextLines.push(`Tool calls this session: ${toolStats.total}${breakdown ? ` (${breakdown})` : ""}`);
  }

  // If a compaction already happened they chain: the new document must
  // absorb the previous one so nothing is lost between compactions.
  const carryOver = previousSummary
    ? `
There is an EARLIER handoff document from a previous compaction. The conversation below happened AFTER it.

Your new document must MERGE both: carry forward everything from the earlier document that is still relevant, and add what happened since. Do not drop earlier decisions, learnings, or constraints just because they are not repeated below.

<earlier_handoff>
${previousSummary}
</earlier_handoff>
`
    : "";

  const user = `${carryOver}
${contextLines.length ? `\n${contextLines.join("\n")}\n` : ""}
Here is the conversation to document:

<conversation>
${transcript}
</conversation>

${COMPACTION_TEMPLATE}`;

  return [
    { role: "system", content: COMPACTION_SYSTEM_PROMPT },
    { role: "user", content: user.trim() },
  ];
}

/**
 * Render messages as readable text.
 * Tool output is trimmed: what matters for the summary is that the tool ran
 * and how it ended, not its full dump.
 */
function renderTranscript(messages, { maxToolChars = 1500 } = {}) {
  const out = [];

  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "user") {
      out.push(`<user>\n${textOf(m.content)}\n</user>`);
      continue;
    }

    if (m.role === "assistant") {
      const parts = [];
      if (m.content) parts.push(textOf(m.content));
      for (const tc of m.tool_calls || []) {
        const args =
          typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function?.arguments || {});
        parts.push(`[calls ${tc.function?.name}: ${truncate(args, 400)}]`);
      }
      if (parts.length) out.push(`<assistant>\n${parts.join("\n")}\n</assistant>`);
      continue;
    }

    if (m.role === "tool") {
      out.push(`<tool_result>\n${truncate(textOf(m.content), maxToolChars)}\n</tool_result>`);
    }
  }

  return out.join("\n\n");
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return String(content ?? "");
}

/** Trim from the middle: the head and tail are usually the informative parts. */
function truncate(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${s.slice(0, head)}\n… [${s.length - max} chars omitted] …\n${s.slice(-tail)}`;
}
