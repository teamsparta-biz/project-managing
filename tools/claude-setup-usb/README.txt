Claude Code dev environment auto-installer (USB, single-file version)
=======================================================================

[File]
- Run-Setup.bat  <- this is the only file you need to run.

[How to use]
1. Copy Run-Setup.bat onto the USB drive (or just this folder).
2. On the target laptop, double-click Run-Setup.bat.
3. Click "Yes" on the admin permission (UAC) popup.
   (Node.js / VS Code installation requires admin rights)
4. When it finishes, follow the on-screen instructions:
   - Open VS Code -> Terminal (Ctrl + `) -> type: claude
   - On first run, a browser window opens to sign in with your Claude account.

[Requirements]
- Windows 10 (22H2+) or Windows 11
- Internet connection (downloads Node.js, VS Code, Claude Code during install)

[What gets installed]
- Node.js LTS (via winget)
- Visual Studio Code (via winget)
- Claude Code CLI (npm install -g @anthropic-ai/claude-code)

[Troubleshooting]
- "winget not found" -> install "App Installer" from the Microsoft Store, then retry.
- "claude" not recognized after install -> close the window and open a new
  PowerShell/VS Code terminal, then try again (PATH refresh issue).
- Blocked by company policy -> ask your IT team about PowerShell/winget restrictions.
