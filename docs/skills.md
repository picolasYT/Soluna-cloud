# Skills

A **skill** is a set of instructions Soluna loads only when a task matches it.
It is the way to teach Soluna a specialised workflow — an API-testing routine,
a deployment runbook, a code-review checklist — without bloating the system
prompt.

The format is the same one used by Claude Code and Codex: a `SKILL.md` file
with a short YAML frontmatter. Skills written for those tools work in Soluna
unchanged, and Soluna skills work in them.

## Anatomy of a skill

```
~/.soluna/skills/<name>/SKILL.md
```

```markdown
---
name: api-testing
description: Use when the user asks to write or run API integration tests
---

# API testing workflow

1. Read the route definitions in `src/routes/`
2. Use `supertest`, never raw `fetch`
3. Each test gets a fresh database via `beforeEach`
4. Assert both status code and body shape
5. Run with `npm run test:integration`
```

Only two fields matter in the frontmatter:

| Field | Required | Purpose |
|---|---|---|
| `name` | no | Identifier; defaults to the folder name |
| `description` | **yes** | When to use it — without this the skill is skipped |

`description` is the **only** part the model sees before deciding. It must
read as a trigger:

| Good | Poor |
|---|---|
| "Use when the user asks to write or run API integration tests" | "API testing helper" |
| "Use when deploying to production" | "Deployment stuff" |
| "Use when the user asks to review a pull request" | "Code review" |

Write the rest of the file in clear, imperative markdown — the instructions
the model follows once it loads the skill.

## Scope and precedence

| Location | Scope |
|---|---|
| `~/.soluna/skills/<name>/SKILL.md` | Every project (user-wide) |
| `<project>/.soluna/skills/<name>/SKILL.md` | That project only |

A project skill **overrides** a user skill with the same name, so a
repository can specialise a general workflow. Search order: project skills
take precedence, then user skills; within each, names must be unique.

## Loading

Only the **index** (name + description + location) enters the system prompt:

```xml
<available_skills>
  <skill>
    <name>api-testing</name>
    <description>Use when the user asks to write or run API integration tests</description>
    <location>/home/you/.soluna/skills/api-testing/SKILL.md</location>
  </skill>
</available_skills>
```

The body loads when the agent calls the `skill` tool. A 3,000-word workflow
costs roughly 20 tokens until it is actually used, so you can install many
skills without crowding the context. In the transcript you will see:

```text
  ✓ Loaded skill api-testing
```

## Installing a skill

### Option 1: drop in a file

```bash
mkdir -p ~/.soluna/skills/api-testing
# write SKILL.md there
```

### Option 2: let Soluna create it

```text
❯ write a skill for api testing
```

The model will ask for a name and description, then write a draft you can
edit by hand.

### Option 3: project-local

```bash
mkdir -p .soluna/skills/api-testing
# write SKILL.md in the project
```

Project skills live with the code, so the whole team shares them.

## Checking what is installed

```text
/skills
```

Shows each skill with its description and whether it is `user` or `project`
scope. A skill with no `description` is listed as skipped — fix the
frontmatter.

## Tips for effective skills

- **One skill per workflow.** Several small, focused skills beat one large
  one. The model picks precisely and loads only what it needs.
- **Write the trigger first.** The `description` is the only thing that
  selects the skill. Make it a condition, not a summary.
- **Include exact commands.** "Run `npm run test:integration`" beats "run the
  integration tests". The model copies what you write.
- **Record what *not* to do.** "Do not mock the database" is as useful as
  "use a fresh database".
- **Reference real paths.** The model is running in your project — tell it
  where things actually are.
- **Keep it short.** The body loads on demand, but a 10,000-word skill is
  still slow to load. Five to thirty lines is the sweet spot.
- **Use your own words.** The model has read your code style; mirror it.

## A complete example

`~/.soluna/skills/deploy/SKILL.md`:

```markdown
---
name: deploy
description: Use when the user asks to deploy, release, or push to production
---

# Production deployment

1. Confirm the target environment (staging vs production). Do not assume.
2. Run `npm test` and `npm run build`. Both must pass.
3. Check `git status` is clean for the files being deployed.
4. Tag the release: `git tag -a v<version> -m "Release <version>"`.
5. Deploy with `npm run deploy:<env>`.
6. Verify with `npm run smoke:<env>`.

## Do not

- Deploy on a red test suite.
- Skip the tag — releases are traceable only by tag.
- Deploy a dependency update without re-running the full suite.
```

## Debugging skills

| Symptom | Likely cause |
|---|---|
| Skill never used | `description` is a summary, not a trigger |
| Skill never used | `description` is missing (skill is skipped) |
| Skill not listed | File is not named `SKILL.md`, or not in a folder |
| Wrong skill loaded | Two skills have overlapping triggers; make them more specific |
| Body not loaded | The model did not call the `skill` tool; check the trigger wording |

See also [safety.md](safety.md) (project instructions) and
[tools.md](tools.md) (the `skill` tool).
