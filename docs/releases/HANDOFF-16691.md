# hbots 1.66.91: chat file chips open a read-only preview on the phone, and every model line stays readable

A bot writes a report as a markdown link, the phone shows it as a chip, and tapping that chip used to do nothing: the chip wrote the file into the desktop right-panel store, which the personal chat shell never renders. This release opens a read-only bottom sheet on the same screen, reads the file through the same project-file query as the Files tab, renders markdown with the existing sanitiser, shows every other text file as source, and closes back to the chat at the same scroll position. It also fixes the Team token usage card found in live QA of 1.66.90: long provider+model labels were cut to unreadable stubs, and the bot name, rank and total floated against the middle of a tall row.

## Changes

- **A chat file chip can be claimed by the host shell.** `ChatMarkdown` takes an optional `onOpenFile({ path, line, label })`. Its chip still resolves a bare file name through the existing workspace-basename lookup first, then offers the resolved path; a `true` answer stops there. The desktop chat and every other `ChatMarkdown` caller pass nothing, so the right panel, editor, browser preview and media behaviour are byte-for-byte unchanged.
- **The personal chat shell answers with a sheet.** A new `ChatFilePreview` provider wraps `MessageList` with the chat's environment and workspace root. Extension decides: `.md`, `.markdown`, `.mdx` render as sanitised markdown; `.txt`, `.log`, `.json`, `.yaml`, `.ts` and the other source extensions the Files tab already knows show as preformatted source. Images, PDFs and binaries return false and keep their existing media/editor path. The sheet is read-only: a header with the file name and full path, a scrollable body, a close control, and safe-area padding; there is no edit, delete or write.
- **One preview body, two callers.** The markdown/text presentation is extracted from `FilePreviewSheet` into `FileTextPreview` and used by both the Files tab and the chat sheet, so sanitisation cannot drift: `remark-gfm`, the GitHub default `rehype-sanitize` schema, `skipHtml`, and `img` disallowed. A previewed report cannot fetch a remote image or run raw HTML.
- **Coverage in the personal shell.** Every bot reply, group-chat reply (through `AssistantMessage`) and proposed-plan card is covered. `TaskDetailScreen`'s result markdown is deliberately left out: it has no `cwd` and no thread, so there is no workspace to read from; inventing one would read the wrong root. Desktop T3 chat surfaces are unchanged by design.
- **Token usage card: the headline belongs to the name.** Rank, avatar, bot name and the total/share/cost column are top-aligned; the name and totals share the first line. Each provider+model line now uses the full content width: the label wraps to at most two lines and keeps its defining words, while the token count and price sit in their own right-aligned column with `whitespace-nowrap`, so neither is ever truncated. Long rows grow; readability wins over equal heights.
- **Model names.** Known brand casing is normalised (`Deepseek` becomes `DeepSeek`), an unresolved model id that is literally `Unknown` reads `Unknown model`, and an unresolved GPT route keeps its product form (`gpt-6.1-sol` reads `GPT-6.1-Sol`, not `Gpt 6 1 Sol`). The existing accessible row label and tap-to-open-bot link are unchanged.
- No server or contract change, no migration, no settings change; `PERSONAL_TASKS_CONCURRENCY` stays 5.

## Validation

- Web unit tests (targeted while iterating): 79 of 79 in 6 files: `ChatFilePreview.test.tsx`, `FileTextPreview.test.tsx`, `filesModel.test.ts`, `ChatMarkdown.chatPreview.test.ts`, `tokenUsagePresentation.test.ts`, `TokenUsageSection.test.tsx`. New cases cover the opener handoff, the path-kind decision (markdown, text, image/PDF/binary, no workspace), sanitised markdown versus escaped source, loading/read-failure/truncated states, the two-line wrapping label with intact values, brand normalisation and the unknown-model name.
- Full personal web suite: 3032 of 3032 tests in 266 files pass (includes the archived-chat screen, which stubs the preview provider). Web `tsc --noEmit`: exit 0. Lint of the changed files: no errors (only pre-existing warnings in `ChatMarkdown.tsx`, `MessageList.tsx` and `ConversationScreen.tsx`).
- Throwaway server from the staged release, 390x844 dark, Playwright on Brave, own fresh root `%TEMP%\hbots-tw-verify16691`:
  - A real bot chat shows `REPORT.md`, `notes.txt`, `plan.json` and `shot.png` chips. Tapping `REPORT.md` (an absolute host path outside the workspace) opens the sheet with the file name, the long absolute path (truncated in the header), the rendered heading, list and table, no raw HTML and no image; close returns to the same chat with the scroll position unchanged.
  - `notes.txt` (workspace-relative with subfolders) opens as preformatted source; a bare `plan.json` is resolved by the existing basename lookup to `sub/plan.json` and opens that file.
  - `shot.png` is not intercepted: the text sheet stays closed; media chips never reach the text opener, so their existing media path is untouched.
  - No horizontal overflow at 390 px; the sheet is 390 px wide, the body scrolls, the header truncates, and the popup carries the safe-area bottom padding.
  - Team token usage card at 390 px dark with the five long routes: every label is readable in one or two lines (`OpenCode · DeepSeek V4.1 Flash`, `Claude · Sonnet 5.5`, `Antigravity · Gemini 3.8 Flash N`, `Codex · GPT-6.1-Sol`, `Antigravity · Unknown model`), every token/price value is intact, the name and total top edges agree, and the page has no horizontal overflow. A fresh isolated throwaway root has no native provider histories, so the five rows were supplied as a fixture in the usage read; the labels are the app's own presentation output.
- Screenshots (absolute paths on this laptop, dark 390x844):
  - `C:\Users\Ht\.personal-bots\qa\hbots-16691\01-report-sheet-390-dark.png`: the REPORT.md sheet, rendered markdown, long path truncated, close control.
  - `C:\Users\Ht\.personal-bots\qa\hbots-16691\02-chat-after-close-390-dark.png`: the same chat after close.
  - `C:\Users\Ht\.personal-bots\qa\hbots-16691\03-text-sheet-390-dark.png`: notes.txt as preformatted source.
  - `C:\Users\Ht\.personal-bots\qa\hbots-16691\04-bare-name-sheet-390-dark.png`: bare plan.json resolved to sub/plan.json.
  - `C:\Users\Ht\.personal-bots\qa\hbots-16691\05-image-keeps-media-preview.png`: the image chip leaves the text sheet closed.
  - `C:\Users\Ht\.personal-bots\qa\hbots-16691\06-token-usage-390-dark.png`: the token card at 390 px dark.
  - `C:\Users\Ht\.personal-bots\qa\hbots-16691\07-token-usage-card-390-dark.png`: the card alone, every model line readable.

## Runtime and activation

No migration (112 to 112), so no production backup per Harout's 20 Oct and 23 Oct rules. Roll back to 1.66.90 `73680437ffa9` (binary only) if the smoke fails. Node stays at 24.22.1. The web client is the whole change; the server bundle is rebuilt unchanged.

## Gate evidence
