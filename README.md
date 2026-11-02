# C# Inline Launch Pad

Run a C# file, or the project it belongs to, straight from the editor.

- **Alt+F5** in a `.cs` file or in the terminal.
- A status bar button that turns into **Stop** while the program runs.
- Output in a reusable terminal beside your code, so `Console.ReadLine()` works.

## Features

- **One key to run.** Alt+F5 saves your files, finds the nearest `.csproj`, and runs it with `dotnet run`. If there is no project, a single `.cs` file runs with .NET 10 file-based app support.
- **Interactive input.** The program runs in a real terminal, so prompts and `Console.ReadLine()` work.
- **Reuse and rerun.** Type `r` or `run` in the terminal to rerun the last file or project. Arguments are passed to the program and remembered for that project:

  ```
  r foo "bar baz"    # runs: dotnet run -- foo "bar baz"
  r                  # reuses the saved arguments
  r --clear          # forgets them
  ```
- **Restart safely.** Running again while a program is waiting for input stops it first, so the new command is never typed into the old program.
- **Clear status.** The status bar shows the run state, and each run ends with an `[Exited with code N]` footer.
- **Terminal closes cleanly.** Closing the run terminal, or typing `exit` in it, is fine. The next run opens a new one.

## Requirements

- Visual Studio Code 1.93 or later.
- The [.NET 10 SDK](https://dotnet.microsoft.com/download) on your `PATH`. If `dotnet` is missing, the extension offers the download page.
- A shell with VS Code shell integration. PowerShell 7 (`pwsh`) on Windows is the tested configuration. Windows PowerShell, Command Prompt and bash are implemented but have had much less testing.

## Usage

1. Open a `.cs` file.
2. Press **Alt+F5**, click the **C# Quick Run** status bar button, or run **C# Quick Run** from the Command Palette.
3. Use the beside terminal for input. Press **Ctrl+C** or click **Stop C# Quick Run** to stop the program.

If the terminal is focused, Alt+F5 may be sent to the shell instead of VS Code. To fix that, add `csharpInlineLaunchPad.run` to `terminal.integrated.commandsToSkipShell`. That setting is an array, so keep the existing entries when you add this one.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `csharpInlineLaunchPad.saveBeforeRun` | `true` | Save all files before running. |
| `csharpInlineLaunchPad.panelWidth` | `35` | Width of the beside terminal, in percent. Applied when the run opens the terminal from a single editor group. Existing multi-group layouts are kept. |

## Known limitations

- **Command Prompt:** arguments containing `&`, `>`, `|` or quotes are not supported.
- **bash:** arguments containing line breaks are not supported.
- **Shells without shell integration** fall back to a marker file. The extension cannot always tell when a run has ended, so the Stop and restart behaviour is less reliable.
- **Multiple `.csproj` files** in one folder: the first one, alphabetically, is used.
- **Parent folders are searched** for a `.csproj`, up to the drive root. A project file in a parent folder is used if the file's own folder has none.

## Troubleshooting

- **"The .NET SDK was not found":** install the .NET 10 SDK and restart VS Code so it sees the new `PATH`.
- **Alt+F5 does nothing in the terminal:** see the setting described under Usage.
- **More information:** set the environment variable `CSHARP_LAUNCHPAD_LOG` to a file path before starting VS Code. The extension writes a timestamped log there. You can also open the **C# Quick Run** output channel.

## Contributing

Issues and pull requests are welcome.

To work on the extension:

1. Run `npm install`.
2. Open the folder in VS Code and press **F5**. The Extension Development Host opens the sample project in `testPyramid/`.
3. Run `npm run compile` after changes, or `npm run watch` to rebuild automatically.
4. Package a `.vsix` with `npm run package`.

## License

[MIT](LICENSE)
