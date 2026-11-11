# Homebrew cask template for a tap (e.g. riffetai/homebrew-riffet). release.sh prints the command
# that fills in the version and checksum.
cask "riffet" do
  version "@VERSION@"
  sha256 "@SHA256@"

  url "https://github.com/riffetai/riffet/releases/download/v#{version}/Riffet-#{version}.dmg"
  name "Riffet"
  desc "Native macOS workbench for Cursor, Codex, Claude Code and other agent CLIs"
  homepage "https://github.com/riffetai/riffet"

  depends_on macos: ">= :sequoia"
  depends_on arch: :arm64

  auto_updates true

  app "Riffet.app"

  uninstall launchctl: "io.github.riffetai.mac.server",
            quit:      "io.github.riffetai.mac"

  zap trash: [
    "~/Library/Application Support/Riffet",
    "~/Library/Caches/Riffet",
    "~/Library/Logs/Riffet",
    "~/Library/Preferences/io.github.riffetai.mac.plist",
  ]

  caveats <<~EOS
    Riffet keeps its conversations in ~/.local/share/riffet, shared with the `riffet` command line.
    `brew uninstall --zap` leaves that directory alone.
  EOS
end
