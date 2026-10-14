# Generate Commit Message

A skill for turning a working-tree diff into a polished, Conventional-Commits
git commit message. It is injected ahead of the `commit_message` task prompt so
the task is self-contained: the agent has both the method (this skill) and the
data (the diff) in a single prompt.

## Input

The prompt contains the changes to describe in two forms:

- a **`git diff --stat`** summary (which files changed, how many lines), and
- the full **`git diff`** (for staged changes `--cached` is used; otherwise the
  working-tree diff).

If either section is empty, there are no changes to describe — say so briefly
rather than inventing a message.

## Method

1. **Understand the change.** Read the stat to see the shape (one file? many?
   mostly additions? a rename?), then read the diff hunk by hunk. Ask: *what is
   the old behavior, what is the new behavior, and why?*
2. **Pick the type** from the Conventional Commits vocabulary:
   - `feat` — a new user-visible capability
   - `fix` — a bug fix
   - `refactor` — behavior-preserving restructuring
   - `perf` — a performance improvement
   - `docs` — documentation only
   - `test` — tests only
   - `build` / `ci` / `chore` / `style` — tooling, pipeline, housekeeping
   Prefer the single most accurate type; when several apply, the dominant one.
3. **Choose a scope** when the change is localized to one component/module
   (e.g. `server`, `client`, `diff`, `auth`). Derive it from the paths in the
   diff. Omit the scope for cross-cutting changes.
4. **Write the subject**: `type(scope): summary`.
   - imperative mood ("add", not "added"/"adds")
   - ≤ ~72 characters, no trailing period
   - captures the *what*, construed from the *why*
5. **Write the body** scaled to the size of the change:
   - a trivial change (a typo, a bump) needs only the subject;
   - a normal change gets 1–3 sentences of *architectural context* — why the
     change exists, what it replaces, and any non-obvious trade-off;
   - a large or multi-area change gets a short summary line followed by
     component-grouped bullets (one per area touched), e.g.

     ```
     refactor(server): route agent calls through a single runner

     Centralize every local-AI invocation behind AgentRunner so config,
     detection, skill injection and the prompt byte-budget live in one place
     instead of being duplicated across handlers.

     - agents: add AgentRunner with detect/run helpers and PATH resolver
     - config: parse agents.toml into a raw struct, convert to camelCase wire
     - handlers: share one run_task orchestration across the four tasks
     ```

## Hard rules

- **Output ONLY the commit message.** No preamble ("Here is a commit
  message:"), no trailing explanation, no quotation marks, and **never** wrap
  the message in markdown/code fences (no ``` ``` ```, no `backticks`).
- The first line is the subject; separate the subject and body with one blank
  line; wrap the body at ~72 columns.
- Describe the change that is actually in the diff. Never reference files,
  functions or line numbers that are not present, and never fabricate a `why`.
- Do not include the diff itself, co-author trailers, or issue numbers that are
  not derivable from the change.
