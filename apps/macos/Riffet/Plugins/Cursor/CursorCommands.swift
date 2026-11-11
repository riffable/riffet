import Foundation

/// The CLI's TUI-only commands (`NativeSession.tsx`): sending one opens the terminal to show it.
/// `compact`/`summarize` are quiet: their compaction arrives as a system activity in the transcript.
private let quietCommands: Set<String> = ["max-mode", "fast", "plan", "ask", "goal", "clear", "fork", "rename", "run-everything", "auto-review", "debug", "vim", "show-thinking", "line-numbers", "status-indicators", "compact", "summarize"]

func cursorCommandNeedsTerminal(_ command: String) -> Bool {
    !quietCommands.contains(command) && command.firstMatch(of: /^(claude|gpt|gemini|grok|composer|kimi|glm|codex|muse|auto)/) == nil
}
