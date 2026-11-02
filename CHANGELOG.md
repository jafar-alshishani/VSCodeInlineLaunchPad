# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-03

### Added
- **C# Quick Run** (Alt+F5, status bar button, or Command Palette) runs the
  current `.cs` file, or its nearest `.csproj`, in a reusable terminal beside
  the editor.
- **Stop C# Quick Run** interrupts the current run.
- `r` and `run` in the run terminal rerun the last file or project. Arguments
  typed after them are passed to the program and remembered per project.
  `r --clear` forgets them.
- Single `.cs` files without a project run through .NET 10 file-based app
  support.
- Exit code footer after each run, and a status bar button that shows Stop
  while a run is active.
- Settings: `csharpInlineLaunchPad.saveBeforeRun` and
  `csharpInlineLaunchPad.panelWidth`.
- Optional diagnostic log, enabled with the `CSHARP_LAUNCHPAD_LOG` environment
  variable. Output also goes to the "C# Quick Run" output channel.

### Fixed
- Closing the run terminal, or typing `exit` in it, no longer breaks the next
  run.
- Re-running while a program is waiting for input stops that program first, so
  the new command is not typed into it.
- Leftover exit-marker files are no longer written into project folders.
