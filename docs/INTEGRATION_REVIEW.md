# Conversation history and Markdown integration review

The independent reviews use `origin/main` at `c26d658` as the baseline. The history review is committed as `da7a1cc`; the Markdown review is committed as `c94776b`. Each feature remains based on the baseline, without importing the other feature. `dev/integrated` fast-forwards its previous history version to the reviewed history branch, then merges the reviewed Markdown branch without squashing. No changes are made to main or upstream.

## Conversation-history findings and fixes

- **Save failures could lose messages or model association.** The first save previously assigned the active conversation only after success, while a failed final save still permitted switching away. The renderer now preserves the conversation identity before attempting persistence, retains a pending snapshot, and retries it before switching, renaming, or deleting. A failed retry keeps the current chat visible. A failure before inference starts leaves the user message intact rather than inventing an assistant response.
- **A sidebar refresh error could prevent inference despite a successful save.** Refresh errors are now reported independently from message-save errors.
- **Delayed image conversion could cross chat/model boundaries.** Comparing active IDs was insufficient for two consecutive blank chats, whose IDs were both undefined. An attachment epoch now invalidates conversions when changing chats/models or sending. Attachment actions are ignored while chat operations are locked.
- **Attachment writes lacked JSON's atomicity.** Both image files and JSON now use a temporary file, fsync, and rename. Failed image commits leave no truncated final attachment. Best-effort garbage collection does not report an already committed save as failed.
- **Rename unnecessarily decoded/re-encoded images and dropped references to temporarily missing images.** Rename now validates and updates stored metadata directly, preserving attachment references and avoiding image I/O.
- **Path validation trusted existing symlinks.** UUID validation is stricter, conversation folders reject symlinks/non-directories, and symlinked records/attachments are rejected rather than followed outside storage. This is not a claim of protection against a hostile local process racing filesystem changes.

The JSON/user-data architecture, portable behavior, local IPC bridge, explicit model association, reasoning/image fields, and event-driven saving remain appropriate for this application. Switching is intentionally disabled during generation; Stop saves partial content before allowing a switch. No inference engines or downloads were changed. A new dev-only happy-dom dependency permits actual React interaction tests rather than storage-only assertions.

## Markdown findings and fixes

- **Memoized controls retained the previous UI language.** The resolved language now participates in MessageBody's memo comparison. Code blocks and copy feedback update without changing message text.
- **Clipboard code included a parser-generated newline.** Copy removes exactly the single synthetic display newline, preserving indentation and intentional blank lines, including unfinished streaming fences.

The shared MessageBody component remains independent from chat state/inference. Raw HTML stays disabled; Markdown images never instantiate image elements; only explicit HTTP(S) links without embedded credentials are routed through the existing external-browser bridge. Raw strings are not rewritten. Components stay stable across streaming renders, the body is memoized by presentation inputs, and no highlighting dependency was added. The Markdown stack adds about 401 KB to the existing unminified renderer bundle; this is accepted for the established parser/GFM implementation rather than replacing it with a custom parser.

## Integration overlap and conflict decisions

| Files/area | Decision |
| --- | --- |
| `src/renderer/src/pages/ChatPage.tsx` | Resolve the import conflict by keeping ConversationSidebar and importing MessageBody. Retain history state/streaming/save guards; remove the obsolete local fenced-code renderer. Every message uses the same MessageBody with the live Markdown setting and resolved language. |
| `src/renderer/src/styles.css` | Keep both appended groups: scoped history layout/divider styling and Markdown typography/code/table styling. Retain Markdown's message min-width rule so overflow stays within bubbles. |
| `README.md`, `README.ja.md` | Keep both adjacent feature sections, in history-then-Markdown order, plus the Markdown dependency license entry. |
| `package-lock.json` | Keep the missing unist type dependency from the Markdown side and the shared happy-dom development dependencies. The combined manifest/lockfile pass frozen `npm ci`; there is one copy of each direct dependency. |
| `.github/workflows/windows-test-build.yml` | Keep one Windows packaging workflow. Include both independent feature branch filters and `dev/integrated`; retain tests, installer/portable uploads, branch/SHA names, and 30-day retention. |
| Shared types, settings, IPC/preload | Compatible automatic merges: history adds conversation IPC; Markdown adds one boolean to existing Settings. Neither changes the other's persistence API. |
| TypeScript/Vitest configuration | The independent frontend test configurations initially merge identically. Cross-layer regression tests need both DOM and Node APIs, so integration adds `tsconfig.test.json` and a third typecheck command rather than exposing filesystem imports to the production renderer project. Vitest explicitly uses the automatic JSX transform. |

## Files changed by integration relative to reviewed history

- `.github/workflows/windows-test-build.yml`
- `README.md`, `README.ja.md`, `docs/INTEGRATION_REVIEW.md`
- `package.json`, `package-lock.json`
- `src/main/settings.ts`
- `src/shared/types.ts`
- `src/renderer/src/components/MessageBody.tsx`
- `src/renderer/src/pages/ChatPage.tsx`, `src/renderer/src/pages/SettingsPage.tsx`
- `src/renderer/src/styles.css`
- `tests/chat-history.test.tsx`, `tests/markdown.test.tsx`, `tests/markdown-settings.test.ts`, `tests/markdown-interactions.test.tsx`
- `tsconfig.node.json`, `tsconfig.web.json`, `tsconfig.test.json`, `vitest.config.ts`

## Validation

| Target | Results |
| --- | --- |
| Reviewed history | Typecheck/build pass; 146 tests pass, 3 skip, 1 existing network test fails. |
| Reviewed Markdown | Typecheck/build pass; 141 tests pass, 3 skip, 1 existing network test fails. |
| Integration | `npm ci`, typecheck, production build, workflow YAML validation and whitespace checks pass. Full suite: 161 pass, 3 skip, 1 existing network test fails. |

Tests run with `NODE_USE_ENV_PROXY=1`. The remaining failure is `tests/gguf.test.ts`, whose external Hugging Face Range request receives proxy HTTP 403. No tests were removed or disabled to hide this result.

History interaction tests exercise delayed load locking, delete-both/New Chat focus, failed-save retries and model identity, late attachments, sidebar errors, and stopped generation content/reasoning. Markdown interaction tests cover live localization, exact clipboard whitespace, clipboard errors, streaming copy feedback, external-link dispatch and the literal/Markdown toggle. Storage tests cover restarts, ordering, rename/delete, portable relocation, malformed/missing files, atomic failures, image deduplication and symlink rejection.

The integration-specific regression creates a real disk-backed conversation with raw Markdown, reasoning, and an image, reloads it through fresh store instances, checks rendered HTML, toggles formatting without changing the saved bytes, then sends another message and verifies original Markdown and image parts in the inference request. Engine metadata is changed between llama.cpp and Transformers to verify the renderer has no engine-specific coupling. Inference itself is mocked; no model/GPU behavior is claimed.

## Remaining limitations

The cloud machine cannot validate native Windows menu/dialog focus or installer execution; the new integrated Windows artifacts require manual testing. DOM tests verify renderer focus/state transitions, not OS-level window-manager behavior. GitHub API access is denied here, so remote Actions status cannot be confirmed.

History still uses synchronous main-process filesystem operations and parses existing records when listing; very large archives/images can pause the UI. No unrelated index/database refactor was introduced. Atomic rename protects against partial records but is not a guarantee of complete durability under sudden hardware/power failure. Unfinished streaming text can be lost on abrupt termination; previously saved messages remain. Unsaved input drafts, per-conversation parameters, and full-text search remain outside scope.
