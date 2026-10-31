# dsh-guard-degen

A degeneration guard for DeepSeek Harness: it contains runaway symbol streams at the
model boundary and ships tooling to repair polluted artifacts and sessions.

## Why

Some models (in our measurements, concentrated in the MiniMax family) degenerate their
reasoning into a single repeated character:

```
⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ ⇒ …
```

Degeneration is not always one character repeated: a **multi-character unit** can repeat
as a whole block over and over:

```
⇒⇒§ ⇒⇒§ §

⇒⇒§ ⇒⇒§ §

… (the same block, again and again)
```

That output is persisted into session files and can even be written by the model into
repository documents and source files. Once a session is polluted, "continue" only yields
more of the same stream — the session is unusable, but the **file** pollution survives
into the next session and accumulates.

This plugin does four things:

1. **Stream containment** — detect symbol runs before the output reaches the UI, and
   truncate/sanitize according to policy.
2. **Write verification** — after a write-type tool runs, read the file back; if it is
   polluted, block the result and feed the finding back to the model.
3. **Retry and model switch** — retry a failed request (same model, N times) and
   optionally switch to an explicitly configured model.
4. **Artifact and session cleanup** — scan the workspace and session history, produce a
   report, and let you pick what to repair (preview only by default; nothing is written).

Artifact governance covers **both shapes**: a run of one symbol, and a multi-character
unit repeated as a whole block. After ticking the entries you want, "preview repair"
shows a **red/green diff** (red = before the repair, green = after it) right in the view,
so you can confirm before anything is written to disk.

The multi-character unit shape is governed in **four** places, each with its own switch
and its own repetition threshold:

| Place | Switch | Threshold | Default |
| --- | --- | --- | --- |
| Artifact repair | `artifacts.unitRun` | `artifacts.unitRepeats` | on / 4 |
| Stream guard | `stream.unitRun` | `stream.unitRepeats` | on / 4 |
| Tool guard | `toolGuard.unitRun` | `toolGuard.unitRepeats` | on / 4 |
| Session masking | `sessions.unitRun` | `sessions.unitRepeats` | on / 4 |

Turning a switch off leaves that place with the single-symbol run rule only; the other
places keep their own setting, so the four guards never drag each other along.
The thresholds are independent too: raise one to be more permissive, lower one to be
more sensitive, without touching the others.

## Install

The package contains both the host half and the browser half. The simplest install is to
append one insert to `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: guard-degen
      name: <relative path to the plugin directory, or a package name>
```

Relative paths in `name` are **anchored beside the patch file** (documented host
semantics), so any local directory works; a bare package name must be resolvable from the
profile's `node_modules` or the installation's own packages.

With a relative-path install the plugin directory must resolve its own runtime
dependencies (`@deepseek-ai/dsh-typert-protocol`, `@deepseek-ai/schemastery`, plus
`@deepseek-ai/cordis` and `@deepseek-ai/cosmokit` that they pull in). This copy ships
those four packages under `plugin/dsh-guard-degen/node_modules/`; copy them along when
moving the plugin, or let npm install them when publishing.

The profile bundle mechanism works too: list `"dsh": { "profile": { "bundles":
["dsh-guard-degen"] } }` in the profile manifest and add the package to `dependencies` —
the package's own `cordis.patch.yml` is then applied as a bundle layer.

The host plugin exposes a native Schemastery `Config` schema, so the settings page
renders a form automatically. The plugin also registers its own **Settings →
Degeneration guard** section (a sibling of **Plugins**) with three tabs under it,
each on **its own page** (they never render on top of each other):

- **Config** — graphical entry points for every setting.
- **Logs** — the verdict log: every degeneration verdict records which rule fired,
  in which session, and what the guard did about it. Every row carries the
  **session ID** and the **session name**, and the list can be filtered by session
  (pick one from the dropdown, or type part of a session ID / name). Selecting a row
  shows the **detected degeneration features** (which unit repeated how many times)
  and the **red/green diff** of the remediation (red = the degenerate text before,
  green = what is left after: the collapse marker when the output was sanitized, an
  explicit "nothing follows" note when it was truncated, and "recorded only, not
  remediated" when the guard did not rewrite anything). False-positive feedback
  lives here too.
- **Artifacts** — the artifact scan report and the list of polluted sessions;
  select entries, then preview and apply the repair. The repair preview is rendered
  as a **red/green diff** per file (red = the polluted text before the repair,
  green = the marker or empty result after it).

The session list shows both the **session title** and the session id. After
"preview masking", the page renders the change inline as a **red/green diff**
(red = original text, green = the marker that replaces it), so there is no need
to open the generated file on disk.

Session masking has **two content modes**, selectable on both the artifacts page
and the session view:

- `Collapse` — fold the degenerate run into `〔退化内容已遮蔽×N〕` (default).
- `Remove` — delete the run entirely. **Nothing is written in its place**: the
  file ends up with the symbols gone, and the green diff line shows the text that
  remains after the deletion (not a sentence standing in for the run). When the
  whole content was degenerate, the green line says so explicitly.

Switching the mode **recomputes the preview immediately**, so the change can be
inspected before anything is written.

Masking also has **two landing modes**, selectable on both pages:

- `Write a separate copy` — the masked content lands in a new file, the archive
  stays untouched (the default on the artifacts page).
- `Rewrite the session archive in place` — **the default inside the session
  view**: the session you are looking at is masked itself, no copy to hunt for.

### The guard view inside a session

The session page's view row (next to **Chat / Trajectory / Context / Squad**) also
carries a **Degeneration guard** view, scoped to the **current session**:

- **Workspace artifacts** — the scan range is the **working directory of the
  current session** (the host resolves it from the session archive header; the
  browser only sends the session id and can never pick a directory), and the
  repair covers the artifacts in that directory.
- **Current session** — mask the degenerate content of the session itself, with
  the same modes as the artifacts page.

"Apply masking" **rewrites the current session in place** by default: the archive
is replaced atomically (temp file, then rename), the original is backed up to
`~/.dsh/guard-degen/backups/`, and the written file is read back and verified.

Three things are worth knowing:

- **The messages on screen do not change right away** — the chat view is served
  from the host's memory; reopen the session to see the rewritten text.
- **A running session keeps appending** — new messages are still appended after
  the rewritten content.
- **The masking is recomputed on the latest content** — if the session was
  written to after the preview, the plan is recomputed so that new messages are
  not dropped.

## Commands

| Command | Effect |
| --- | --- |
| `/degen-status` | Guard status, rule table, recent verdicts |
| `/degen-scan [paths…]` | Read-only artifact scan (defaults to the workspace) |
| `/degen-fix <file…>` | Repair the given files (backs up before rewriting) |
| `/degen-clean` | Mask degeneration in the current session (writes a copy by default) |
| `/degen-ack` | Record the latest verdict as a false positive and relax that rule one step |

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `modelIncludes` | `[]` | Guard only these models (empty = all) |
| `stream.reasoning` | `truncate` | Reasoning policy: `off`/`truncate`/`sanitize` |
| `stream.text` | `sanitize` | Text policy |
| `stream.holdbackChars` | `256` | Characters held back before a verdict |
| `stream.maxInterventionsPerCall` | `1` | Max interventions per call |
| `stream.unitRun` | `true` | Also govern multi-character units repeated as a whole block |
| `stream.unitRepeats` | `4` | How many repeats of a unit count as degeneration (stream guard) |
| `toolGuard.mode` | `warn` | Degeneration in tool arguments: `off`/`warn`/`refuse` |
| `toolGuard.scope` | `all` | `all`/`write-only`/`oversized-only` |
| `toolGuard.unitRun` | `true` | Also govern multi-character units in tool arguments |
| `toolGuard.unitRepeats` | `4` | How many repeats of a unit count as degeneration (tool guard) |
| `postExecute.enabled` | `false` | Write-back verification (costs IO) |
| `postExecute.roots` | `[]` | Restrict verification; empty = inside the workspace |
| `retry.policy` | `same-model` | `same-model`/`steer`/`no-retry` |
| `retry.maxSameModelRetries` | `1` | Same-model retry count |
| `retry.switchModel.enabled` | `false` | Allow an automatic model switch |
| `artifacts.mode` | `collapse` | `collapse` (marker) or `remove` |
| `artifacts.apply` | `false` | Preview only by default |
| `artifacts.unitRun` | `true` | Also govern multi-character units repeated as a whole block |
| `artifacts.unitRepeats` | `4` | How many repeats of a unit count as degeneration |
| `artifacts.maxFileBytes` | `8388608` | Per-file size limit; larger files are skipped (and listed) |
| `sessions.mode` | `copy` | `copy` (new file) or `replace` |
| `sessions.maskMode` | `collapse` | `collapse` (marker) or `remove` (delete the run) |
| `sessions.unitRun` | `true` | Also govern multi-character units in session content |
| `sessions.unitRepeats` | `4` | How many repeats of a unit count as degeneration |
| `logging.enabled` | `true` | Persist the verdict journal |

Runtime edits are written to `~/.dsh/guard-degen/config.json`, layered over the profile
configuration.

## Safety boundaries

- **Read-only by default**: artifact repair and session masking default to `apply=false`;
  the preview phase writes nothing.
- **Back up before rewriting**: a real write produces `<file>.degen-backup` first; if the
  backup fails, the original file is left untouched.
- **Read-back verification**: after rewriting, the file is read again and the residual
  runs are counted; a non-zero residual is reported as an error rather than a success.
- **Runs, not single symbols**: legitimate markers such as `★` exist in real repositories,
  so only *runs* of a symbol count as degeneration.
- **Multi-character units only count in symbolic regions**: a block like `⇒⇒§ ⇒⇒§ §`
  repeated end to end is a separate degeneration shape (marked `〔退化单元×N〕`). The unit
  must contain at least one non-ASCII character, so code, tables and normal prose are not
  misjudged; a run of one symbol stays the business of the run rule, so nothing is
  reported twice.
- **The leftover fragments are judged too**: degenerate content often alternates a long run
  with fragments (`⇒⇒⇒⇒… ⇒⇒⇒⇒… **⇒⇒ **`). Removing the runs makes the fragments touch, and
  they can form a *new* multi-character unit repeat. The unit rule therefore judges the
  fragments left after the runs are taken out, so one repair pass clears both — otherwise the
  read-back verification would reject the result with "verification failed" and the user
  would get nothing.
- **The browser cannot widen a threshold**: the run length, the symbol set and the unit
  thresholds come from the configuration, never from the browser request; a page that asks
  for a looser threshold than the configured one is ignored.
- **Tool-call arguments are preserved**: session masking keeps tool-call blocks byte-identical
  (their pairing must not break), which means roughly 24% of the polluted symbols — the ones
  inside tool arguments — are intentionally left in place.
- **Only model-produced content is rewritten**: masking touches the text and reasoning of
  `assistant/message` events (and compaction summaries); user prompts, system messages and
  tool results are left byte-identical.
- **No writes outside the roots**: artifact scanning and repair are bound to `artifacts.roots`
  (the working directory by default); an explicit file list cannot bypass the roots, and
  symlink targets and non-UTF-8 files are skipped. `/degen-fix` binds each run to the
  directories of the files you named, so pointing at a file outside the workspace still
  works — but nothing else in that tree is touched.
- **The browser cannot pick write targets**: remote methods only forward allow-listed
  arguments; output, backup and audit paths are decided by the plugin. Masking copies,
  backups and audits are written to `~/.dsh/guard-degen/{masked,backups,audit}/`, never
  into the session directory. Masking only accepts targets under `~/.dsh/sessions`.
- **Nothing to mask, nothing written**: if a session holds no degenerate run, masking
  leaves the archive byte-identical and creates no backup.
- **A run that spans two blocks cuts the stream**: the host pushes deltas block by block and
  offers no way to retract what was already released. When the head of a run has already been
  released, the guard therefore **cuts the stream** instead of folding only the tail — a
  half-folded marker would both under-count the symbols and leave raw symbols in the text.
  The cost is a truncated answer, which is the right failure mode: the session was going to
  be restarted anyway.
- **The marker count matches the text**: the block-end text is authoritative in the host
  assembler, so the `〔退化符号流×N〕` marker is rewritten in it too — the count in the archive
  equals the number of symbols actually removed.
- **Symlink targets are never masked**: a session target that is a symbolic link is refused
  outright (even when it resolves inside the session root), and the root check compares real
  paths, so a link inside the root cannot rewrite a file outside it.
- **The intervention cap truncates instead of leaking**: when the per-call rewrite budget
  is used up, the stream is cut with an error finish — the raw symbols never reach the
  conversation.
- **Bad configuration never lands**: `setConfig` validates the merged result first and refuses
  to persist invalid values.
- **Skipped files are called out**: files over `artifacts.maxFileBytes` (8 MB by default) are
  not inspected; they are listed in the report's `skippedTooLarge` and shown in the GUI —
  "not scanned" must never read as "clean".

## Development

```bash
node --test test/*.test.mjs
```

The suite does not require the host runtime (apart from a few integration checks that use
the real cordis package).

Standalone checks live in `../../verify/` (run them with the same node binary):

| Script | What it proves |
| --- | --- |
| `check-patch-config.mjs` | the bundled `cordis.patch.yml` matches the schema defaults |
| `check-client-contribution.mjs` | the browser contribution loads and its remote calls line up with the host |
| `check-host-load.mjs` | the host class instantiates in the real cordis and exposes all 13 remote methods |
| `check-package-files.mjs` | the package manifest points at files that exist (`npm pack --dry-run` equivalent) |
| `check-mutations.mjs` | every fix is pinned: reverting it turns a test red |
