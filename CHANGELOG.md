# Changelog

User-visible changes only. [简体中文](CHANGELOG.zh-CN.md)

## Unreleased

### Workbench

- Tasks on the task board can wait on other tasks: starting one whose prerequisites are not done queues it, and it starts by itself once they are all accepted as done, with what they delivered in its brief; if a prerequisite is marked not needed, the queued task goes to the inbox for you to decide. The personal assistant orders the tasks it plans the same way. In the task board settings you can pick a Verification Agent: after each delivery it inspects the actual changes read-only, and its verdict (pass, fail, or unclear) shows on the review card and in the task details, where its conversation can be opened; with follow-up on, follow-up sends work back based on that verdict. Off by default; each check runs one more conversation. Web only for now.
- Conversations on the web have a Trace view beside Canvas: every row of the session's log with each revision, model requests with input, cache, and output tokens and, under each, the tool calls, thinking, and text it produced, each tool call with its input, output, and duration, and each turn's run with its requested and actual model and dispatch timings. The header shows active time, counts, and a token breakdown; the timeline below it can be zoomed with the scroll wheel, resized by dragging its bottom edge, and dragged across to narrow the list to a time range, whose edges have grips to adjust it and a bar on top to slide it. The Prompt button shows the system prompt and tool definitions each model request was sent with, with what changed between versions; a model request also shows the messages the agent added to it (reminders, instruction files, environment), read from Claude Code and Codex transcripts. Turn it off under Plugins.
- In a conversation you can @ another Agent (Claude Code, Codex, …) and the conversation's Agent can then call it: the called Agent works in a conversation of its own that you can open, watch, and join, and its answer comes back to the caller. By default it only reads the project; asked to make changes, it works in a new worktree. On the @-mentioned Agent you can pick the provider, model, effort and Fast it runs on; left alone, the conversation's Agent picks them, seeing the same models, parameters and quota you see in the model menu. Turning on Call other Agents under Skills & Tools lets the Agent call any Agent without an @. The new-conversation page takes @ too; the mention is written in your message, and clicking it picks the model. Cursor conversations can now use Riffet's tools as well (calling other Agents, phones, the browser and so on); under Ask each time each call asks you first. Web only for now.
- Two Riffet servers can be linked (Settings › Server links, or `riffet link` on the command line): one creates a link string and the other pastes it, or `riffet link ssh <host>` links over SSH when the ports are not reachable. Each server decides on its own whether the other may operate it (off by default) and can see what the other did on it; ending the link on one side ends it on both. Once a server may operate the other, the web sidebar, search and ⌘K list the other server's projects and conversations alongside its own, labelled with the server they are on, to open, send to and start new ones in; Add project and Choose another directory… can pick which server to use. While the other server is offline its conversations stay listed, marked offline. Web only for now.
- The Access group in Settings is now called Connections; it holds Connection & Access, Devices and Server links.
- Plugins can now work with the personal assistant: a plugin can raise events that start a delegation's background run (ask the assistant to "tell me when X happens"; events are not replayed if the server was down), ship a capability pack that appears in the assistant's settings while the plugin is on and goes away with it, and let its views open a link in your browser.
- Installed plugins can give their pages their own icon in the web sidebar, More menu and ⌘K, drawn in the same line style and colour as the app's icons.
- Clicking a button in a plugin's page no longer leaves a focus ring on it once a key is pressed; as in the rest of the app, the ring shows only when you move with Tab or the arrow keys.
- A plugin can ask you to approve something in the task board's inbox, such as a pending write: the row shows the plugin, a title, a short description, and the buttons it offers; the choice goes back to the plugin. Pending ones survive a restart, go away when withdrawn, expired, or the plugin is turned off, and a new one is pushed to your iPhone. Web only for now.
- Keyboard shortcuts can be set by you: Settings on the web and the Mac has its own Shortcuts page, under Behavior after Input. Click a row and press the new keys, or turn a shortcut off or reset it. A combination already in use names its holder and can be taken over; combinations the browser or the system keeps cannot be used. The settings stay on this device.
- Shortcut conflicts fixed: the Mac's system-wide quick prompt now defaults to ⌥Space, since ⌃⌥Space switches input sources (a key you recorded stays); on the Mac, switching between the conversation and terminal views is now ⌥⌘T, leaving ⇧⌘T to reopen a closed tab. On the web, ⌥ with a letter in a Mac text field no longer swallows accent input (such as ⌥I), and inside the terminal, Ctrl and ⌥ combinations go to the terminal (⌃` still closes it).

- A new conversation's default Agent, when none was chosen, is now the first one installed in the order Claude Code, Codex, Antigravity, Cursor, Pi, TRAE, Droid (then Agents from plugins), or Claude Code when none is installed, instead of always Cursor. The web, the Mac, phones, and bots all start new conversations on the same one, and Agent lists everywhere follow this order. A default Agent you chose is kept.
- First-install defaults: the web and the Mac follow the system language (Chinese when the system uses neither Chinese nor English); the conversation list is grouped by time on the web, the Mac, and Android, as on iPhone; iPhone opens on New session; the terminal font defaults to 12.5 on every platform; the sidebar pins Personal assistant, Task board, and Plugins. Settings you changed stay as they are.
- Notification permission is requested only on the first-run guide's notifications page and from the notifications switch in Settings: the web and Mac guides gain that page, and Android no longer shows the system prompt as soon as it connects. The Mac guide's last page offers Open Riffet at login, checked by default; skipping the guide leaves it off.

- The Mac can be handed to Agents as a device: after turning on “Allow agents to operate this Mac” in Settings › Connection & devices (owner verification required) and picking this Mac under Skills & Tools for a conversation, an Agent can list and capture windows, read and write the clipboard, open web links, and post notifications. A capture never brings the window to the front, and it works with only the menu bar left. The switch is off by default and saved per server; content copied from a password manager is not read, and only http and https links are opened.
- On the Mac, Stats, Extensions, Plugins, Automations, Marks, Activity, and the settings sections stored on the server have an Open in Web toolbar button that lands on the same page on the web, already signed in. Collaboration, the task board, title rules, and voice input now have entries on the Mac that open the web (sidebar, settings, or command palette). The web is the reference for these management pages from now on; the ones the Mac already has stay as they are.
- Web settings sections have addresses: `/settings/<section>` opens that section directly.
- Exported pictures of a selection or a highlight keep the answer’s formatting: headings, lists, code, tables, and bold text. Under Display, the conversation title, Agent, model, project, and date can each be turned on or off; the model is the one that wrote that answer.
- The web task board shows a 14-day chart of new and completed tasks, all six task statuses, inbox and running counts, and linked conversations for the current filters. Cards sit directly under their column headings, and status details, assignees, and timestamps line up across the inbox and watching sections.
- Text files can be edited on the Mac, iPhone, and Android too: the pencil in the Mac file preview edits in place and ⌘S saves; on phones, Edit opens an editing page. A file an Agent changed meanwhile is never overwritten without asking. On the Mac and iPhone, PDF, Word, PowerPoint, and spreadsheet files open in Quick Look; Android draws PDFs natively.
- Plugins can show project files they understand: a plugin that declares a viewer for some file extensions appears in the Files view’s ⋯ menu for those files, beside View as hex. Viewing the end of an empty file no longer fails.
- In the Files view, any file can be viewed as hex, a text file from its end with Follow for logs (text over 32 MB opens this way), and selected text in a rendered preview (Markdown, documents, PDF) can be quoted into the conversation. With LibreOffice on the server, Word and PowerPoint files, including .doc and .ppt, are shown with their original layout; `riffet doctor` says whether it was found.
- Text files in the Files view can be edited on the web: turn on Edit, save with ⌘S, and keep unsaved edits while you look at other files. A save never overwrites changes an Agent made meanwhile; you compare the two versions and choose per change, take the disk version, or save over it. Files and folders can also be created, renamed, and deleted from the file list, and a deletion can be undone from its notice.
- Audio and video in the Files view play at any size and can be seeked, on the web, Mac, and phones; they previously had to be under 32 MB and played only from the start.
- Session title rules (Settings › Behavior › Session titles) decide how sessions are named by folder, Agent, origin, or tag. A template can use the original title, the project name, the date, and the time, and a rule can also cover titles you renamed. Rules change only what is shown; the CLI keeps its own session name. The web, Mac, and phones all show the ruled names.
- The web app now opens with a full-window first-run guide: pick the default Agent (with install commands when none is available), choose the directory to start in, and scan to connect your phone; every step can be skipped. It appears once per browser, and not at all on a server that already has conversations.
- The web stays responsive with thousands of conversations: the sidebar, the command palette, and title search draw only the rows on screen, so opening a conversation no longer stalls for half a second; code blocks over 100 KB are shown without highlighting instead of freezing the page; typing in the message box does less work per key. A tab in the background stops polling, and a flaky network is retried with backoff instead of reloading everything on each reconnect.
- Android scrolls conversations more smoothly: a fling past diagrams no longer stalls on each one (a diagram now draws once the list stops), a long edit opens at once and scrolls within its box, and typing no longer re-ranks every conversation unless an @ mention is open.
- Android fixes: an image that once failed to load (for example, mentioned before the Agent wrote it) now loads on the next try instead of failing until the app's data was cleared; opening an edit that was too large to send whole now fetches all of it, so it no longer shows as deleting the file.
- On Android, the personal assistant page folds the bottom bar into a round button beside the message box instead of stacking the two, leaving two or three more lines for the conversation; tap the button to open the bar and switch pages.
- Android has a new default interface style, Riffet: cards set apart by tone with no outlines, regular-weight rows, a one-line task list with the state at the end of each row, and selection that slides between tabs and filters. Devices that never picked a style switch to it; the five earlier styles stay under Settings › Interface style.
- The Android Riffet style drops a few horizontal lines: under the conversation title, under a bottom panel's title, and above the model panel's parameter bar.
- `riffet doctor` has a Storage section: the integrity of the three databases, blobs the log refers to that are missing, and records that belong to no conversation. A minute after start the server also checks the two databases that cannot be rebuilt in the background; damage is reported in the log with the restore command, and no file is touched.
- `riffet logs --scope dispatch` shows each message's delivery steps and the phase its conversation is in, for finding out why a message was not sent or keeps running.
- On the web, a model-source plugin's Settings tab now lists every Agent provider that uses it, with expandable account and per-model quota bars, a Models subpage, direct links to edit or add providers, and its own gateway fields grouped as Default connection; providers sharing the same gateway address and key also share one quota read.
- On the web, a plugin's Settings tab now shows what it runs on this server: an Agent plugin lists its configurations with CLI and sign-in state, a task plugin its recent tasks, a share plugin the shares still live (which can be unpublished), and Feishu Bot its bots with their connection state. Android Build lists missing tools and connected devices, and TRAE Queue Acceleration says whether acceleration is on and, if not, why. Antigravity and Feishu Bot have an introduction, and plugin introductions follow the interface language.
- Quota bars now fill with what is left, matching the “n% left” beside them, so a bar shrinks as the quota runs out (web providers and plugin pages, the Mac model menu).
- Android no longer has quick chat: New session only starts tasks, and the quick chat entries from text selection, sharing, the launcher shortcut, the Quick Settings tile, and Settings are gone. `riffet://new?prompt=` now opens New task with the text filled in. Quick chat stays on the web and the Mac.
- On Android, the app now opens on New session by default (a launch tab you picked earlier stays). Swiping left or right on a tab moves to the neighbouring tab, the page following your finger, and quick swipes in a row move one tab each without waiting for the page to land; the sidebar opens with a right swipe only on New session, and from the menu button anywhere.
- The Android terminal key bar always fits the screen width, so ⏎ is never cut off, and ⏎ is filled like the send button; ↑ sits directly above ↓. Newline is now on the first row and inserts a line break in Claude Code and Codex without sending; ⏎ still sends. Under More, paste, attachment, line input, and release control come first.
- The iPhone New session page no longer has a quick chat tab; it only starts tasks.

### Fixes

- Codex conversations on a model that is not OpenAI’s behind a custom endpoint (such as DeepSeek) fold the model’s thinking into the thinking row instead of showing it as prose between tool calls.
- In the web composer's fullscreen editor, Enter now starts a new line whatever the Enter key setting, and ⌘/Ctrl+Enter sends. The new-conversation page offers fullscreen editing too; there its button sits left of Send, and the permission icon comes before the model.
- Reading an assistant reply near the top of a Web conversation while it is still streaming no longer jumps upward when the turn finishes and its process block folds; folding now waits until the process block scrolls out of view.
- A conversation forked from a task’s conversation now gets a task of its own; changing the original’s status no longer changes the fork’s. A handoff still stays on the original task.
- An unconfirmed steering message whose turn has already finished or been stopped no longer resurfaces as “Waiting for the previous message to be confirmed” and deadlocks new sends after the CLI exits or the server restarts, and previously released unconfirmed messages no longer stall new sends when the CLI is offline or block idle reclamation, handoff, terminal resume, or deletion.
- Android swipes are more reliable: a list that was just flung or is bouncing back, a diagonal swipe, a state that only blocks system back (such as Settings while switching servers), and archiving or deleting the personal assistant conversation whose details are open no longer stop the tabs or the side drawer from swiping. Content that scrolls sideways hands the swipe on to the tabs or back navigation once it reaches its end, and a sideways swipe nobody takes no longer taps the row under it. A sheet’s inner page now goes back one level on a right swipe or the back key instead of closing the whole sheet.
- Output speed (tok/s) across live indicators, turn bubbles, and Stats is now measured consistently across Agents: Claude Code ignores out-of-order side records and anchors on request starts instead of dropping or spiking speeds, Codex/TRAE excludes subagent waits and includes unstreamed reasoning and tool-argument generation, Cursor streams live decode speed directly from the live tap, resolves run attribution via request ids, and no longer anchors post-restart steps to stale prompt timestamps, Droid and DSH fall back to request-level timing for tool calls and batched chunks, Pi now reports output speed, Quick Chat separates time-to-first-token from streaming decode, and implausible millisecond bursts no longer skew turn averages or rolling live rates.
- Context usage meters now report accurate figures and matching breakdowns across Agents and clients: Claude Code shows its exact prompt-side cache/input breakdown instead of labeling it estimated or adding output tokens, Cursor reads the CLI's live token count instead of lagging or stale breakdown snapshots, DSH marks its heuristic breakdown as estimated, Codex/TRAE drops stale previous-turn categories when a new turn moves usage, and breakdown percentages on Web, Mac, Android, and iPhone now divide by the context window with complete localized labels.
- When Cursor refuses the model a new conversation started with and its first message runs only after you pick another model and resume, that message is now confirmed as delivered, instead of showing “Waiting for the previous message to be confirmed” and holding every later message.
- On Android, the thin vertical line between the sidebar and the page in dark mode is gone.
- On Android, opening a panel while the keyboard is up (such as the message box's send settings) slides the keyboard down to uncover the panel at the bottom edge, with the message box and conversation following the keyboard. The message box and conversation no longer drop all at once with the page behind flashing through, and the panel no longer stops above the keyboard before coming down. Confirmation dialogs appear once the keyboard is down, and menus leave the keyboard where it is.
- After switching a Claude Code model or provider while a background task (such as a dev server) is still running, the conversation now says the new settings apply once background tasks finish and offers End background tasks and apply, instead of leaving later messages queued with no explanation.
- A Claude Code message sent just as the CLI reports a background task left over from before a restart is now confirmed as delivered, instead of showing “Waiting for the previous message to be confirmed” and holding every later message in the queue.
- When a Claude Code answer is cut off mid-stream (`API Error: Connection lost mid-response`), the text it had already written stays in the conversation instead of disappearing, and when the part of a conversation you were reading is removed, the view moves to what remains instead of showing a blank screen.
- Plugin Agent icons (such as Doubao) load from cache and preload on the web instead of re-reading and revalidating on every model-picker open.
- Named Cursor model families (such as Gemini, Composer, and Grok) now show the 300K / 1M / MAX context window selector in the model picker instead of hiding it behind a partial prefix allowlist.
- Running `riffet` on an older Node.js version no longer fails with a long list of `styleText` color names in truecolor terminals; the CLI now checks `engines.node` up front with a version-manager-specific upgrade command, and falls back to 16-color output when hex styles are unsupported.
- When no Agent has been chosen yet, the web new-session page now starts on an installed, available Agent instead of an uninstalled Cursor with the send button disabled; when the Mac guide finds only one Agent, it now also makes it the server's default.
- `riffet update` on a source install no longer refuses with “Could not tell which source CLI process … uses” because some unrelated process, such as a shell that changed to another directory, mentions `apps/server/src/cli.ts` in its command line.
- `riffet update` on an npm install now checks both your configured registry and `registry.npmjs.org` (plus any `RIFFET_NPM_REGISTRIES`), and installs with `--registry` when a mirror has not synced the new version yet instead of failing with `ETARGET`.
- After a gateway plugin such as AsterGate is turned off or uninstalled, providers that use it keep working with their own address and key instead of failing to load models; only its quota stops showing.
- On the web, the composer no longer shows the microphone when the selected voice recognizer's plugin is turned off or uninstalled; Settings › Voice input marks that recognizer as unavailable.
- On Android, the new-session icon in the bottom bar now lines up vertically with the other tabs instead of sitting slightly higher.
- A message queued while the Agent is answering no longer shows above that answer for a few seconds after it goes out.
- In Cursor conversations, a queued message offers "Add to current task" as soon as the turn starts; with some gateways it previously appeared only after the Agent's first tool call.
- A message no longer stays running, holding back the ones queued behind it, when the agent answers quickly and its transcript record arrives a moment later.
- A queued message no longer waits indefinitely when the previous turn has ended but the idle status never arrived; it goes out within half a second.
- A task worktree whose directory was deleted by hand can be created again at the same path instead of failing as already registered.
- With a very large message history, a two-character search across conversations reads at most the newest 500,000 messages instead of slowing the whole server as history grows.
- Claude Code shell commands that only read, search, or list files show what they read, like Codex's: `Read MarkLayer.tsx, textQuote.ts` or `Search quoteOf in src` with the read or search icon, instead of the whole command line. Other commands still show their description or command, and the full command stays in the expanded row.
- On Android, tapping a session's composer no longer stutters as the keyboard opens: the composer unfolds as part of the keyboard's own motion, and folds back with it when the keyboard is put away. A bottom sheet opened while the keyboard is up rises from the bottom edge instead of first appearing above the keyboard.
- The Android Git panel shows only "Not a Git repository" for a project that is not one, without a read-failure error above it.
- Sending a message no longer flashes (briefly disappearing and fading back in) when a fast Agent accepts or finishes it before the timeline row arrives.
- In the Personal Assistant conversation on the web, `/new` now appears as a "New topic" divider and collapses earlier topics by default (expandable anytime, and auto-expanded when searching or jumping from the outline), while background maintenance trims oversized old tool outputs past 14 days without affecting search or memory consolidation.
- On iPhone, the first hold to talk after launch in a conversation where you had sent a message no longer crashes the app.

### Performance

- iPhone is smoother with thousands of conversations and long transcripts: the task list scrolls and opens a conversation without the second-long pause, a long conversation opens and keeps up with a streaming reply without rebuilding everything above it, and typing into a long draft no longer stutters. Opened attachments stay on the phone (up to 256 MB) instead of downloading again after a restart, the image viewer loads a sharper copy for zooming, and formulas draw without a web page each. The first search in Settings no longer freezes the page for over a second, an unreachable server's status page is asked less and less often, and the Git panel reconnects after the network drops.

## 0.9.0 - 2026-11-19

### Upgrade notes

- On first start, Riffet splits the single `workbench.db` into `workbench.db`, `journal.db`, `derived.db`, and `blobs/`; back up your data directory before upgrading if you may need to roll back to 0.8.0.

### Fixes

- Reading an in-progress reply on the web (including Cursor conversations and long virtualized transcripts) no longer jumps when the turn finishes and its process block folds, even when the prompt or process header is still visible at the top of the screen or right after scrolling; non-virtualized conversations also no longer snap unrendered earlier rows from an 88px estimate, and transcript scrolling now uses one deterministic anchor owner across browsers.
- In Cursor conversations, a subagent that was interrupted no longer shows as running after it stopped.
- On the web, answering a question or approval card no longer leaves a blank gap at the bottom of the conversation; clicking the empty area beside the transcript no longer stops it from following new output.
- In Claude Code conversations, adding a message to the current task now works after Riffet restarts in the middle of a turn; when a message can't be added, you're told it was queued as the next message instead of it silently returning to the queue.
- The conversation outline no longer lists a queued message again each time it is withdrawn or replaced; previously the extra entries stayed until the page was reloaded (Web, Android, iOS).
- In Claude Code conversations, a table in a reply that is still streaming now shows as a table instead of box-drawing text in a code block.
- Reading partway through a long streaming reply on the web no longer shifts when the reply finishes and replaces its live draft or re-parses Markdown above the viewport.

- Single tildes in prose (such as `~1.18 GiB`) no longer turn into strikethrough text in replies and previews; `~~strikethrough~~` still works.
- `.mdc` rule files (as well as `.mdown`, `.mkd`, and `.mdx`) now render as Markdown previews with a metadata table for YAML frontmatter and syntax highlighting in code blocks on the web and Mac.
- File paths starting with `~/` expand to the server user's home directory when previewed or linked, and inline code file mentions work consistently across Web, Mac, iPhone, and Android (including `:line:col` and allowed outside-project files).

- Starting a new conversation no longer shows "Stop and send" under the first message; queue actions now appear only on queued messages in the dock, driven by the server across Web, Mac, Android, and iPhone.
- In Cursor conversations, steering remains available from prompt submission and after a server restart or opening the terminal drawer; "Stop and send" replaces the running turn immediately without stalling queued messages for 60 seconds, and stopping a turn keeps its tool calls expanded under "Stopped" instead of collapsing them as "Processed".
- Focus rings no longer appear on a button, list or game you clicked once you press Space, Escape or start typing, nor on what a shortcut or the command palette opens; they show only when Tab or the arrow keys move focus. Web.
- The Background tasks list in the side panel and on narrow screens no longer ends with "The session reports N background tasks; some task details haven't loaded yet". Web.
- Automations page (Web): the editor is wider, with the name and task on the left and the agent, project, schedule and delivery on the right. The agent field, and the quick bar, use the composer's agent, provider and model menu, including the model's effort, Fast and other parameters. Clicking a row opens it for editing (an agent wake-up or a send-later opens its conversation). "Recent runs" no longer lists "Deleted task": wake-ups and send-laters that have run show only in their conversation.
- A subagent's own background commands no longer show up on their own at the end of the main conversation. Background tasks are titled by the agent's description; without one, by the command's first line in monospace, minus the leading `cd` into the project. Web.
- Stopping a running Claude Code turn works again instead of failing with "Could not stop; try again".
- PDF file previews in the Files panel, message attachments, and shared links now render pages instead of stalling on the file name.
- On the web, row hover and keyboard focus highlights inside rounded cards (Settings groups, provider cards, Automations lists, and Extension file lists) now clip cleanly to the card's rounded corners.
- Reading an in-progress reply on the web no longer jumps or flashes when the turn finishes and its process block folds above the viewport, including when scrolling back up past the folded block. Collapsing a tool or process block near the end of a conversation brings the content above down instead of leaving blank space below.
- On the web, a newly started turn (such as one woken by a background task) sits cleanly below the previous answer's footer instead of crowding into it, and no longer reuses the finished turn's timer or speed before its first row arrives.
- While the web Collaboration page loads, the stage, each seat's role and the discussion's question are in place first, with same-size placeholders for Agents, models, progress and speeches, so nothing jumps once it loads; it no longer shows a lone "VS", and opening a discussion no longer shows just a spinner.
- Opening or closing an image preview from message attachments, composer thumbnails, diagrams, marks, or the right-hand Files panel on the web now plays its smooth transition animation in production builds too, and clicking an image in the Files panel opens the full-screen lightbox.
- Switching between New Task and Quick Chat on the web keeps the composer in the same vertical position instead of shifting up and down.
- Riffet can restart after a storage upgrade when conversation timelines contain deleted rows.
- Cursor command and file approvals appear in the conversation when the terminal shows a review shortcut or the top of a long preview has scrolled out of view.
- Less empty space under answers in a conversation: the hidden time and actions line no longer adds its own row on top of the gap between turns, and resting the pointer anywhere in the (wider) band under an answer for 150 ms shows it, instead of only over a small spot on the left. Web and Mac.
- A long subagent report in a web conversation now shows "Show all" inside the expanded report, after its preview, and loads the rest in place. It no longer sits under the collapsed row and disappears when clicked without showing anything. Reports that arrive after the turn has ended can now be shown in full too.
- When a background agent reports back while its turn is still running, the web conversation keeps that turn in one "Working" block with the report inside it, instead of splitting it into two blocks that both show "Working".
- A new Claude conversation can start and send its first message when no matching prewarmed session is available. Starting fresh after repeated Claude exits also works with the conversation open.
- Claude: if its terminal fails to start, opening the conversation again starts it instead of reporting the conversation as not found. A new conversation also starts its CLI only once.
- Opening the web model picker scrolls the currently selected model into view (along with the active Agent and provider columns when shown), and keeps the selection in view when switching back to the active provider.
- In the web new-session model picker, clicking an available Agent or provider switches to it directly and restores its last chosen provider, model, and parameters (instead of staying in preview until a model is clicked); opening the menu while parameters or quota are still loading no longer locks the list to a shorter height.
- The personal assistant can list built-in and shared Riffet Web themes and available plugin palettes even when a message has no connected tab. Retrying an unsent message from the assistant now identifies the workbench that submits it.
- Sending a personal assistant message with several Riffet Web tabs open no longer waits behind each tab’s sidebar updates on HTTP/1.1 connections.
- The personal assistant can read and change the theme after you reload Riffet Web, and an open tab can reconnect after a server restart.
- On the web, approval requests and questions appear directly below the last conversation entry, without an empty progress row between them.
- When a turn finishes, its thinking and tool calls fold into "Processed" even if you had scrolled up during the turn; they stay open only when you opened a tool or thinking item inside that block or have text selected in it.
- When translating a reply or a selection fails, the translation card stays in place with the reason and a Retry button (and Choose a model when no model is set yet), instead of disappearing into a toast. Closing a card while it is still running stops the request, and changing the target language in the plugin settings translates again on the next click.
- On mobile, paging through a long conversation keeps earlier messages and commands in their original positions, including completed commands such as `/summarize`.
- With a title model chosen in Settings, it names every conversation, including the ones Cursor, Claude Code, Codex and Droid had already named themselves; a name you set, also with `/rename` in Claude Code, stays. Titles are shorter and more specific, start with what is being done, and keep your own terms such as review or prompt. Conversations the agent already named before this update keep their names.
- Links in replies carry a light underline on the web, Mac and iPhone, so they stand out in themes whose accent is the text colour, such as Pencil.
- When a Cursor turn fails after running tools, the conversation shows the error once after that work. The error stays visible when the process is folded, including in earlier conversations.
- Sending a message shows "Sending" (or "Resuming") at the bottom of the conversation until the agent starts its turn, then switches to "Working" before the first thought, tool call or reply appears; the "Working" line stays for the whole turn, also while the agent is only thinking.
- Cursor conversations keep showing the current turn as running while the agent thinks, keep subsequent tool calls and replies (including tool calls that read images) in the same turn, and fold to "Processed" as soon as the turn finishes.
- Scanning a pairing QR works when the Mac has several network addresses and the phone can reach only some of them, such as Wi-Fi that keeps wireless devices apart while the wired address answers: the QR carries every address and the phone pairs at the first that answers. Android also falls back to these addresses later if the one it uses stops answering.
- Sending a message to an agent no longer waits for the undo checkpoint: the checkpoint is saved while the message goes out, where each message in a project with many uncommitted changes used to wait 0.3–3.5 s. Files the turn changed before the checkpoint finished are listed when undoing the turn, which is then refused rather than restoring the wrong content.
- Cursor with an API gateway starts in about a second instead of 10–30: the queries the CLI makes before its prompt are answered from the server's memory and refreshed behind it, so a change to models or plugins shows one start later.
- Cursor: a slow-starting CLI no longer shows "the CLI has not shown its prompt bar" after 15 seconds, and a message sent while the warm CLI is still starting waits for it instead of starting a second one. A CLI waiting for login says so right away.
- Cursor: a first message with several lines, or one ending in `;`, no longer fails with "Native terminal launch command is invalid" when no warm CLI is ready.
- A conversation that failed while its first message was sending shows the error once, not twice.
- An agent that fails at startup (a wrong model, an invalid key) before Riffet has attached to its terminal now shows as failed with its reason, instead of going idle with no explanation.
- A failed conversation's mark on its sidebar row or tab (the red dot, "出错" on the Mac, "Failed" and the avatar mark on phones) clears once you have opened it.
- Codex tool call rows combine repeated file reads and searches into one action with short file names (such as `Read service.ts, runtime.ts, app.ts`), keep the search or file icon when a command only reads and searches, show only the first line of multi-line shell commands and heredocs while folded, list modified file names beside commands that changed files, and no longer mark searches with no matches (`exit 1`) as failed.

### Workbench

- Settings › Views (Web): added "Process auto-fold" (`At turn end` / `On next message`, device-local, defaults to `At turn end`) so readers who prefer zero layout change above a finishing reply can defer folding a turn's process block until the next message is sent.
- Shared conversation pages now use the full transcript reader—with chapter navigation, width dragging, in-page search, remembered code fence toggles, and direct PDF export—and show confirmation when a share link is created or updated.
- Task board adds a "Watching" status (with optional snooze deadline and observation notes), renames cancelled tasks to "No longer needed", adds board search and collapsible sections, and separates active from idle items under In progress.

- The web sign-in page is one centred column: the command to run on the server, the code field and Continue, with QR pairing and the access-token option below. A browser that cannot reach the server says so and reconnects by itself instead of asking for a sign-in, and a browser that never signed in no longer sees "Your sign-in has expired".
- A small game while you wait, on the web: when the workbench cannot load or the sign-in page cannot reach the server, a running track appears with fences to jump on the beat (Space or a tap). Bump the floating mane teeth to light the mane: a higher jump, then a longer one, then double points; a crash costs a tooth before it costs the run. Run "Dark Horse Run" from the command palette to play any time: on the new conversation page the track sits at the bottom of the page; in a conversation it sits in the empty space beside the composer, is not offered when there is no room, and closes if the room runs out. It pauses while the Agent waits for you and ends at a finish post when the turn ends. Escape closes it.
- JSON, JSONL, YAML, TOML, and XML file previews now feature syntax coloring, inline collapsed summaries, live search filtering, expandable multi-line strings, formatted source with line numbers, and a table plus record-inspector split view for JSONL and object arrays.
- HTML pages previewed in the Files panel (or opened in a new tab) now load the stylesheets, scripts and images next to them, and their links open the linked page in place; the panel header follows the page being shown. Web, Mac, Android and iPhone.
- Settings › About Riffet now includes a link to the Riffet GitHub repository (`riffable/riffet`) across Web, Mac, iPhone, and Android.
- Auxiliary models now prioritize low latency and transparency: Settings › Auxiliary models adds a dedicated "Default model" decoupled from Quick chat, marks slow CLI-process models, disables thinking across protocols, caches short-lived auth credentials, streams message/selection translations and handoff previews, generates session titles as soon as the first turn starts running, and adds an API benchmark dialog, a "Prompt & logs" inspector, and a categorized model leaderboard on Stats (Short jobs, Streaming, Long context, Agent chat).
- On the web, the context usage popover now includes a "Compact context" action at the bottom for Agents that support manual compaction (Cursor, Claude Code, and Codex), triggering each Agent's native compaction command without disturbing your draft.
- Database and checkpoint disk usage is substantially smaller and space is reclaimed automatically while Riffet runs: history logs and large outputs are compressed, superseded tool revisions and cold subagent timelines are pruned automatically, duplicate project checkpoints share hard links, and Settings › Storage separates control data, history journal, and rebuildable cache with a one-click online cleanup action (Web and Mac).
- Files in the conversation aside's Outputs list now show monochrome file-type icons aligned with the sections above on both Web and Mac; opening a file's diff dialog on the web includes a jump-to-preview button beside the file path.
- Claude Code replies now appear as they are written, on every client, instead of a whole paragraph or section at a time. The streamed text may show headings and emphasis plainly until each part is complete. Conversations that were already running when Riffet started stream again from their next message.
- Switching conversations on the web keeps the page in place: the header, side column and composer stay where they are and only the conversation fades in briefly, as on the Mac. The context meter and the running indicator show the last known state right away.
- Feishu bots now come from the built-in Feishu plugin. Turning it off under Plugins disconnects the bots and keeps them, with their chats and projects, until it is turned back on.
- Permission modes in the composer toolbar on the web and Mac now show as compact icons with full titles and descriptions in the menu (and in the session options sheet on Android and iPhone), with four selectable icon styles (Shield, Semantic, Gate, and Ring) under Settings › Icons; switching permissions in a Cursor conversation persists across resumes without flashing or showing a false "Working" indicator.
- Planned tasks above the personal assistant's input box can now be dismissed, and leave the bar as soon as you open one on the board or start it; capability pack shortcut buttons above the input box are hidden.
- Usage statistics now group models by their base family name across rankings, latency, trends, filters, and the runs table instead of splitting variants by `effort`, `fast`, or `context`, and add thinking effort distribution, token composition and per-model cache hit rates, project distribution, autonomy and sub-agent share, and per-run token / cache sorting on the model ranking. Daily wait time excludes multi-hour idle gaps and merges overlapping waits across parallel sessions, and the top pending/wait card holds its height while loading.
- Ask the personal assistant which tasks need you, why a plugin is unavailable, or what a restart would interrupt. It can watch a task for a status change, adjust supported preferences on an authorized Riffet client and edit a shared custom theme. Changing the default Agent, provider or model requires a separate confirmation from the owner.

- `@` session references work in Cursor, TRAE CLI, Droid, pi and DeepSeek Harness conversations, in addition to Claude Code, Codex and Antigravity.
- In the personal assistant on Riffet Web, you can ask to change the workbench palette or switch between light, dark and system appearance in the browser that sent the message.

- The terminal’s More actions menu in the web development build can export a layout report with row counts and cursor positions from the browser and tmux.
- Pairing a phone with the Mac no longer needs a terminal: when the local server only accepts this computer, click "Allow devices on the same network" on the pairing page or in the first-launch guide, or switch it in Settings › Connection at any time. The server restarts once no conversation is running, and browsers on this computer will need to sign in afterwards.
- The Mac, Android and iPhone apps open their main window without a server: appearance, language, shortcuts and other settings kept on the device work as usual, and pages that need a server say so and take you to connect. The first launch walks you through starting or connecting a server, choosing the default agent and a starting folder, and pairing your phone, full screen and skippable at every step; whatever you skip is finished later from the new-conversation page.
- Voice input on the web, Android and iPhone: speak into the input box and the text appears at the caret. Choose a speech-to-text service that speaks the OpenAI format in Settings › Input on the web, or install the Local speech recognition plugin, which downloads its engine and models on demand and shows text as you speak. On a phone the mic switches to voice mode: hold to talk, release to insert, slide up to cancel, or tap to keep recording until you tap done. In a browser the microphone needs an HTTPS address; the phone apps do not.
- New Codex and Claude Code conversations start sooner: while the new-conversation page is open, the agent is started ahead of your first message, as Cursor already was. The first reply comes about 1.5–3 s sooner from Codex and about 0.6 s sooner from Claude Code. One started but not used ends when you leave the page.
- The model menu remembers each provider's last model with its effort and Fast settings: switching back to a provider starts on it, and picking another model keeps effort, Fast and the context window where that model offers them. Quota figures from the last reading show as soon as the menu opens, also after a reload, while a fresh reading loads.
- Added a Collaboration page to the sidebar: run a 1v1 debate between Agents (pro and con speak in turn and cross-examine each other, a judge keeps a ledger each round and gives a verdict), a roundtable (several models speak each round, a moderator sums up and wraps up when they converge), multi-perspective answers, and document reviews (accept edits, then get a revised draft). Each seat can be any Agent, provider and model (subscription logins included) and keeps the Agent's skills, MCP servers and plugins; a quick chat model works too. Each format remembers its last seats and rounds, and seats show the model they actually run on. Seats stand on facing podiums on the start page, and a debate opens on a scoreboard showing both sides, the momentum read from the judge's notes, and progress. In a 1v1 debate pro and con face each other in two columns, cross-examination questions get their own card marked answered, dodged or pending, models speaking at once sit in a row of cards, and the judge's and moderator's notes get cards of their own. Speeches stream word by word with their thinking and tool calls folded in, you can add a note or stop at any time, and the conclusion can go into a session or a task.
- Favorites on the web now filter by type, unlinked status, project, and agent from a contents column (moving to a header menu on narrow screens), switch between grid and list views with search match highlights, and open a reader dialog to read full text, copy code, change highlight colors, edit notes, or relocate unlinked favorites.
- On the web, the left sidebar is slightly wider by default, and opening another page such as Favorites or Plugins clears the selected state on the previous conversation row.
- Extensions lists shared `~/.cursor/rules/*.mdc` rules, project `AGENTS.md` and `CLAUDE.md` for Cursor, `.claude/CLAUDE.md` for Claude Code, `AGENTS.override.md` for Codex, and rules for Droid and TRAE CLI, showing each rule's path, when it applies (always on, matching globs or paths, on demand, or overridden by `AGENTS.override.md`), and summary. In the scope menu, the personal assistant now sits right below User configuration.

### Performance

- Storage stays bounded over long-term heavy use and backs up faster with less disk overhead: the rebuildable timeline cache is capped at 256 MB (evicting the oldest idle conversations first) and auto-rebuilds on startup if corrupted; small history records use dictionary compression and leaner indexes, inactive conversations older than 90 days (30 days when archived) trim oversized raw tool logs while keeping all messages and diffs, and repeated backups deduplicate unchanged attachments, blobs and checkpoints via hard links with consistency checks.
- The server uses less memory while it backfills Claude Code token usage: a long conversation's history is read line by line instead of loaded whole, so peak memory for a 240 MB history drops from about 590 MB to 170 MB. The image library is loaded only when an image is first processed, about 30 MB less at startup.

## 0.8.0 - 2026-11-17

### Upgrade notes

- Workbench addresses are paths now (`/c/<conversation>`, `/p/<project>`, `/tasks`, `/stats` …). Links and bookmarks in the old `#s=…` form no longer open a conversation.
- Templates, schedules and agent wake-ups become one kind of record, Automations; existing ones are migrated on first start.
- `riffet` commands are renamed: `login-url` is now `url --login`, and `install-service` / `uninstall-service` are `service install` / `service uninstall`. `start` and `status` no longer print a sign-in link with the access token; use `riffet url --login` or `riffet token`.

### Tasks and the assistant

- Task board: a conversation can belong to a task, its status changes from the sidebar menu, and the task shows in the conversation's info.
- Assistant: one long-running personal assistant with its own page, memory, background runs and capability packs; `/new` starts it over. Available on the web, Mac, Android and iPhone.
- Automations run a prompt by hand or on a schedule and keep the last 50 runs.
- The assistant runs on Claude Code or Codex, the two agents that keep it apart from your own instructions, skills and MCP servers. On Codex it now has its directory's and packs' MCP servers, cannot edit your files, compacts at 200k tokens, and runs its background work there too.
- A new task takes one sentence, lets you pick the model, and is either added to To do or started right away; completion criteria are optional. A new Task board settings page sets the default agent and model, and whether new conversations become tasks (off by default).
- Settings are regrouped: new Features, Access and Server groups; bots, the assistant and quick chat sit under Features.
- Work a turn delegated (subagents, background commands) stays visible after the turn ends.
- A Claude Code subagent's report shows in the main conversation's notice and as the answer on the subagent's page; messages the main conversation sends a subagent mid-task show on both sides.

### Backends

- Antigravity CLI is a supported agent.
- Antigravity: a model the gateway serves under its own id (such as `gemini-4-hydrogen-sonar`) no longer turns into agy's default model when the conversation starts, and the conversation says so when agy still picks another; models offer a thinking effort; agy 1.5.10 is supported.
- Antigravity lists what a provider's own gateway serves, rather than agy's built-in models, and a model source that serves the Gemini protocol can be chosen as its gateway type. Model sources now give their model list per protocol, so a new agent needs no adaptation in them.
- A provider that uses a model source no longer shows as not ready right after Riffet or the source's plugin starts.
- After an agent's plugin is updated or reloaded, its open conversations keep showing new replies; before, they stopped updating and the message was reported as possibly unsent.
- Codex conversations continue when switching to a compatible model provider; Codex CLI 0.167.2 is supported.
- Codex has a Deny permission mode: it edits the workspace freely and refuses anything more instead of asking.
- Goals from Claude Code `/goal`, Codex and DeepSeek Harness show on every client.
- New Cursor conversations start on a warm CLI, and live output token counts reach the usage view.
- Fixes for Claude Code: `/clear` moving to a new session, auto-compaction placement, `!` commands sent from Riffet, fallback confirmations in auto mode, forked Skill subagents.
- Claude Code: a turn the agent wakes itself for (`/loop`, a scheduled wake-up) shows as working while it runs, and its working time counts from that turn rather than the one before.
- Idle CLIs are reclaimed by last use and a memory budget you can set; settings show why each one is kept.

### Workbench

- Find within a conversation.
- Git panel: history, line-level staging and a live status stream, on every client.
- Plugins: a public plugin index, several plugin sources with installs pinned to their source, plugin pages, message-menu commands, and provider quota through model-source plugins. A Riffet browser plugin opens pages the agent can drive.
- Selectable and customizable code highlighting themes.
- Markdown: safe inline HTML tags, table alignment and copy, picture attachments.
- Tables in answers on the web drop the frame and column lines for rules between rows, and a short label column no longer wraps one word per line.
- Tabs: new conversations can open as a temporary tab, and pinning or opening another conversation no longer drops the wrong one; tabs stay in step across windows.
- The side panel floats over the conversation and stays open per conversation. Skills and tools move into the composer's + menu; permission modes have names.
- Settings: a storage page with a breakdown of the data directory and scheduled compaction; agent defaults separate from model providers.
- Sidebar: pinned destinations with the rest under More, and footer actions in the avatar menu.
- Sidebar: a running conversation shows a spinner, set apart from the dot for a new result; a task conversation's status ring turns while it runs.
- Sidebar: when a newer release is out, its version shows at the bottom right and opens Settings › About Riffet, which lists what changed since your version.
- Sidebar: clicking a conversation's project name or agent icon opens the conversation; before, the click did nothing.
- The image viewer shows the image alone; on the web it grows from its thumbnail.
- Web on a phone: the image viewer no longer lets the page show through, flickers between two sizes, or covers the image with zoom buttons (pinch to zoom); scrolling the sidebar no longer opens a conversation's ⋯ menu; the avatar opens Settings; a conversation's header keeps an info button at its right end, and its details fit on one screen with every command under More; page titles sit closer to the menu button; the send and stop button is smaller.
- Plugins page: installed plugins and each plugin source are listed side by side, and plugins show as cards in up to three columns. Plugin sources are added, turned off and removed from that list; plugins with an update get their own entry.
- Selecting text in an answer or a progress note shows a compact toolbar that stays with the selection as you scroll: quote it into the composer (a chip there, a Markdown quote when sent), side chat, highlight with a color on hover, copy, export as an image, and plugin actions such as Translate, whose result opens beside the selection.

### Command line

- `riffet` is redone in English: help grouped by purpose, calm colors, and a suggestion for a mistyped command. New `ls`, `resume` with a searchable picker, `logs --since` / `--scope`, `service status`, and tab completion for zsh, bash and fish.
- An npm install updates itself with `riffet update`; `riffet status` notes when a newer release is out, and `riffet`, `riffet start` and `riffet resume` offer to update before running when a newer release is ready to install.

### Clients

- Installs without a source build: `npm install -g riffet`, and an Android APK on GitHub Releases. The macOS DMG is not published yet.
- macOS: native conversation canvas; web parity for tabs, overview, code navigation and settings; beta updates through Sparkle (About → receive beta updates).
- iPhone: pages rebuilt on a shared design layer, push notifications, and fixes for main-thread crashes.
- Android: pull down for search on root pages, the full title in the details pane, and a composer that folds back when empty.
- Unread state is shared across clients.

### Performance

- The server keeps process spawns and database checkpoints off the event loop, drops cold timeline rows, and syncs sidebar lists by deltas.
- Caches on the server, web, Mac and phones have size limits; the service monitor shows each connected client's resource use.
- A server restart keeps running turns.

## 0.7.0 - 2026-11-12

First public release, open source under Apache-2.0.

### Backends

- Drives the official CLIs already installed and signed in on the machine, and reads their session stores in place: Cursor (`cursor-agent`), Claude Code (`claude`), Codex (`codex`), DeepSeek Harness (`dsh`), Factory Droid (`droid`), TRAE CLI (`traex`) and pi (`pi`). See the capability matrix in the README for what each backend supports.
- A CLI session already running in a terminal can be imported and continued; a Riffet session can be handed back to the terminal.
- `riffet doctor` shows each CLI's version and flags versions below the minimum supported or above the last verified one.

### Workbench

- The timeline folds consecutive tool calls, edits expand into diffs, and subagents get their own transcript page; Mermaid, D2, Graphviz, PlantUML, Vega-Lite and KaTeX render locally.
- Backends with a TUI can switch between the structured conversation and the terminal behind it; sessions keep running on the host after the client closes.
- Steering a running turn, side chats, quick chats, highlights and bookmarks, session sharing and PDF export, usage statistics.
- Review comments on diffs; 2–4 parallel attempts, each in its own Git worktree; handing a session to another backend, forking from any turn, restoring checkpoints; pushing branches and opening GitHub pull requests through the local `gh`.
- Local previews for more than 20 file formats, including PDF, Office documents, Jupyter notebooks, SQLite, 3D models and archives.
- Plugin API `@riffet/plugin-api`: model sources, workbench views, color themes and native runtime companion processes.

### Clients and channels

- Web: English and Chinese interface, installable as a PWA.
- macOS (15+): native SwiftUI + AppKit app with a bundled server, a menu bar presence and a global quick-ask shortcut.
- iPhone and Android: pairing by QR code, switching between several servers; approvals, diffs, remote folders and a touch terminal.
- Feishu / Lark bot: the server opens the connection outward, so no public endpoint is needed; new and continued sessions in direct messages or group topics, with approvals answered in the chat.
- Android preview: with two confirmations, an agent can read and operate a paired phone and schedule one-off wake-ups of its own session.

### Security

- Listens on the loopback address only by default; remote devices join with a one-time pairing code. Token scopes, plain HTTP on the LAN and key storage are described in [SECURITY.md](docs/SECURITY.md).

### Known limitations

- Source installation only for now; the npm package, macOS DMG and Android APK are not published yet.
- Windows is not supported.
