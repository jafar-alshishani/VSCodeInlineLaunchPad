import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const execFileAsync = promisify(execFile);
const installUrl = "https://dotnet.microsoft.com/download";

const runTerminalName = "C# Quick Run";

type ShellKind ="powershell" | "cmd" | "bash";

let runTerminal: vscode.Terminal | undefined;
let terminalPromptReady = false;
let runSequence = 0;
let isRunActive = false;
let activeExecution: vscode.TerminalShellExecution | undefined;
let lastCSharpDocument: vscode.TextDocument | undefined;
let runStatus: vscode.StatusBarItem;
let runHelperPath: string | undefined;
let outputChannel: vscode.OutputChannel | undefined;
const logFilePath = process.env.CSHARP_LAUNCHPAD_LOG;
// Distinguishes this VS Code window from others sharing the extension storage.
let instanceId = "";
// Marker of the run whose exit has not been seen yet; cleared once it is read.
let lastMarkerPath: string | undefined;
// Marker embedded in the helper script on disk, so a typed `r` can watch it.
let scriptMarkerPath: string | undefined;
// Command text that starts the helper script. Matched against shell execution
// end events, which do not reuse the same object as the start event.
let runCommandLine: string | undefined;
// Set when the shell reports that the helper command has finished, which also
// happens when Ctrl+C aborts the script before it can write its marker.
let runEndedSinceStart = false;
// A terminal being replaced because its program ignored Ctrl+C. Its close
// event must not be treated as the user closing the current run terminal.
let terminalBeingReplaced: vscode.Terminal | undefined;

// Writes to the "C# Quick Run" output channel and, when CSHARP_LAUNCHPAD_LOG is
// set (see .vscode/launch.json), to that file so a development session can be
// inspected from outside the Extension Development Host.
function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  outputChannel?.appendLine(line);
  if (logFilePath) {
    try {
      appendFileSync(logFilePath, `${line}
`);
    } catch {
      // Logging must never break a run.
    }
  }
}

function showError(message: string, ...items: string[]): Thenable<string | undefined> {
  log(`error: ${message}`);
  return vscode.window.showErrorMessage(message, ...items);
}

function showWarning(message: string, ...items: string[]): Thenable<string | undefined> {
  log(`warning: ${message}`);
  return vscode.window.showWarningMessage(message, ...items);
}

export function activate(context: vscode.ExtensionContext): void {
  runHelperPath = path.join(context.globalStorageUri.fsPath, "run-helper");
  instanceId = randomUUID().slice(0, 8);
  outputChannel = vscode.window.createOutputChannel("C# Quick Run");
  if (logFilePath) {
    try {
      mkdirSync(path.dirname(logFilePath), { recursive: true });
      writeFileSync(logFilePath, "");
    } catch {
      // Falls back to the output channel only.
    }
  }
  log(`activated (pid ${process.pid}, platform ${process.platform})`);
  const runCommand = vscode.commands.registerCommand(
    "csharpInlineLaunchPad.run",
    runCurrentFile
  );
  const stopCommand = vscode.commands.registerCommand(
    "csharpInlineLaunchPad.stop",
    stopCurrentRun
  );

  runStatus = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    -1000
  );
  runStatus.show();
  updateRunUi(false);

  const activeEditorChanged = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor?.document.languageId === "csharp") {
      lastCSharpDocument = editor.document;
    }
  });

  const shellExecutionStarted = vscode.window.onDidStartTerminalShellExecution(
    (event) => {
      if (
        event.terminal === runTerminal &&
        isRunAlias(event.execution.commandLine.value)
      ) {
        runSequence++;
        activeExecution = event.execution;
        log(`typed run alias detected: "${event.execution.commandLine.value}" (sequence ${runSequence})`);
        updateRunUi(true);
        runCommandLine = event.execution.commandLine.value;
        runEndedSinceStart = false;
        // A typed run writes the same marker as the last run, so watch for it
        // too; otherwise the spinner would never reset when the typed run ends.
        if (scriptMarkerPath) {
          lastMarkerPath = scriptMarkerPath;
          void monitorRunCompletion(scriptMarkerPath, runSequence);
        }
      }
    }
  );

  const shellExecutionEnded = vscode.window.onDidEndTerminalShellExecution(
    (event) => {
      const commandLine = event.execution.commandLine.value;
      const isRunExecution =
        event.execution === activeExecution ||
        (runCommandLine !== undefined && commandLine === runCommandLine);
      log(
        `shell execution ended: "${commandLine}" (exit code ${event.exitCode}, ` +
          `this run: ${isRunExecution}, same terminal: ${event.terminal === runTerminal})`
      );
      if (event.terminal === runTerminal && isRunExecution) {
        runEndedSinceStart = true;
        activeExecution = undefined;
        updateRunUi(false);
      }
    }
  );

  const terminalClose = vscode.window.onDidCloseTerminal((terminal) => {
    if (terminal === terminalBeingReplaced) {
      terminalBeingReplaced = undefined;
      log("replaced run terminal closed");
      return;
    }
    const isRunTerminal =
      terminal === runTerminal ||
      terminal.creationOptions.name === runTerminalName;
    log(
      `terminal closed: "${terminal.name}" (creation name "${terminal.creationOptions.name}", ` +
        `same object as run terminal: ${terminal === runTerminal}, ` +
        `exit ${terminal.exitStatus?.code}/${terminal.exitStatus?.reason}; ` +
        `terminals now ${describeTerminals()})`
    );
    if (isRunTerminal) {
      resetTerminalState();
    }
  });

  // Closing the editor tab of a terminal created with hideFromUser only hides
  // it: the shell keeps running and no close event is raised. Treat a closed
  // run-terminal tab as closing the terminal so the next run starts fresh.
  const tabsChanged = vscode.window.tabGroups.onDidChangeTabs((event) => {
    const closedRunTab = event.closed.some(
      (tab) =>
        tab.input instanceof vscode.TabInputTerminal && tab.label === runTerminalName
    );
    if (!closedRunTab || !runTerminal) {
      return;
    }
    log("run terminal tab closed");
    const closingTerminal = runTerminal;
    // A tab that was only moved between groups reappears straight away.
    setTimeout(() => {
      const stillOpen = vscode.window.tabGroups.all.some((group) =>
        group.tabs.some(
          (tab) =>
            tab.input instanceof vscode.TabInputTerminal && tab.label === runTerminalName
        )
      );
      // Only act on the terminal that was closing; a new run may have replaced it.
      if (stillOpen || !closingTerminal || runTerminal !== closingTerminal) {
        return;
      }
      log("run terminal tab did not reappear; disposing terminal");
      resetTerminalState();
      closingTerminal.dispose();
    }, 300);
  });

  context.subscriptions.push(
    tabsChanged,
    runCommand,
    stopCommand,
    runStatus,
    outputChannel,
    activeEditorChanged,
    shellExecutionStarted,
    shellExecutionEnded,
    terminalClose
  );

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor?.document.languageId === "csharp") {
    lastCSharpDocument = activeEditor.document;
  }

  void cleanStaleFiles();
}

// Forgets the run terminal and cancels any in-flight run that was using it.
function resetTerminalState(): void {
  log(`resetTerminalState (was active: ${isRunActive}, sequence ${runSequence})`);
  runTerminal = undefined;
  terminalPromptReady = false;
  activeExecution = undefined;
  // A dead terminal will never write its marker, so nothing can be waited on.
  lastMarkerPath = undefined;
  runSequence++;
  updateRunUi(false);
}

function isTerminalAlive(terminal: vscode.Terminal | undefined): boolean {
  return terminal !== undefined && terminal.exitStatus === undefined;
}

const staleMarkerAgeMs = 10 * 60 * 1000;
const staleHelperAgeMs = 30 * 24 * 60 * 60 * 1000;

// Removes leftovers from earlier sessions. Markers are only ever waited on for
// seconds, so old ones are dead. Helpers from other windows are kept until
// they are long unused, and remembered arguments (.args) are never removed.
async function cleanStaleFiles(): Promise<void> {
  if (!runHelperPath) {
    return;
  }
  const directory = path.dirname(runHelperPath);
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    // The storage folder may not exist yet.
    return;
  }

  const now = Date.now();
  for (const name of names) {
    const isMarker = /^(exit-.*\.marker|setup-.*\.ready)$/.test(name);
    const isHelper =
      /^run-helper-[0-9a-f]{8}(-session)?\.(ps1|cmd|sh)$/.test(name) &&
      !name.includes(`-${instanceId}`);
    if (!isMarker && !isHelper) {
      continue;
    }

    const filePath = path.join(directory, name);
    try {
      const { mtimeMs } = await fs.stat(filePath);
      const maxAgeMs = isMarker ? staleMarkerAgeMs : staleHelperAgeMs;
      if (now - mtimeMs > maxAgeMs) {
        await fs.unlink(filePath);
      }
    } catch {
      // Another window may have removed the file first.
    }
  }
}

export function deactivate(): void {
  runTerminal?.sendText("\u0003");
}

function describeTerminals(): string {
  const names = vscode.window.terminals.map(
    (terminal) =>
      `"${terminal.name}"${terminal === runTerminal ? "*" : ""}${terminal.exitStatus ? " (exited)" : ""}`
  );
  return `[${names.join(", ")}]`;
}

async function runCurrentFile(): Promise<void> {
  log(`run command invoked (active ${isRunActive}, terminals ${describeTerminals()})`);
  const activeDocument = vscode.window.activeTextEditor?.document;
  const editorDocument = activeDocument?.languageId === "csharp"
    ? activeDocument
    : lastCSharpDocument;
  if (!editorDocument || editorDocument.languageId !== "csharp") {
    void showWarning("Open a C# (.cs) file to run it.");
    return;
  }

  if (editorDocument.isUntitled) {
    void showError(
      "Save this C# file to disk before running it."
    );
    return;
  }

  const sequence = ++runSequence;
  log(`run requested: ${editorDocument.uri.fsPath} (sequence ${sequence}, active ${isRunActive}, terminal alive ${isTerminalAlive(runTerminal)})`);
  const settings = vscode.workspace.getConfiguration("csharpInlineLaunchPad");
  if (settings.get<boolean>("saveBeforeRun", true)) {
    const saved = await vscode.workspace.saveAll(false);
    if (sequence !== runSequence) {
      return;
    }
    if (!saved) {
      void showError(
        "Could not save all files. The C# run was not started."
      );
      return;
    }
  }

  // Typing the new command before the old program has exited would feed it to
  // that program as input. Wait for its marker, which is written after exit.
  const previousMarker = lastMarkerPath;
  if (previousMarker && runTerminal && isTerminalAlive(runTerminal)) {
    const previousTerminal = runTerminal;
    const stopped = await interruptPreviousRun(previousTerminal, previousMarker);
    if (sequence !== runSequence) {
      return;
    }
    if (!stopped) {
      // Ctrl+C was ignored. Disposing the terminal ends its shell and program,
      // which is more reliable than typing into a program that is still alive.
      log("previous run ignored Ctrl+C; replacing its terminal");
      terminalBeingReplaced = previousTerminal;
      runTerminal = undefined;
      terminalPromptReady = false;
      activeExecution = undefined;
      lastMarkerPath = undefined;
      previousTerminal.dispose();
    }
  }

  let projectPath: string | undefined;
  try {
    projectPath = await findNearestProject(
      path.dirname(editorDocument.uri.fsPath)
    );
  } catch (error) {
    void showError(
      `Could not find a C# project: ${errorMessage(error)}`
    );
    return;
  }
  if (sequence !== runSequence) {
    return;
  }

  try {
    await execFileAsync("dotnet", ["--version"]);
  } catch (error) {
    if (sequence !== runSequence) {
      return;
    }
    if (!isMissingDotnet(error)) {
      void showError(
        `Could not check the .NET SDK: ${errorMessage(error)}`
      );
      return;
    }

    const action = "Install .NET";
    const selection = await showError(
      "The .NET SDK was not found. Install the .NET 10 SDK, then try again.",
      action
    );
    if (selection === action) {
      await vscode.env.openExternal(vscode.Uri.parse(installUrl));
    }
    return;
  }

  if (sequence !== runSequence) {
    return;
  }

  const cwd = projectPath
    ? path.dirname(projectPath)
    : path.dirname(editorDocument.uri.fsPath);
  log(`project: ${projectPath ?? "none (single-file mode)"}`);
  const terminalWasCreated = !isTerminalAlive(runTerminal);
  const groupCountBeforeOpening = vscode.window.tabGroups.all.length;
  const terminal = getRunTerminal(cwd);
  if (!runHelperPath) {
    terminal.show();
    void showError("Could not initialize the C# run helper.");
    return;
  }
  const shell = getShellKind(terminal);
  log(`terminal ${terminalWasCreated ? "created" : "reused"}, shell ${shell}`);
  const extension = shell === "powershell" ? ".ps1" : shell === "cmd" ? ".cmd" : ".sh";
  // Helper files are per window, so two VS Code windows cannot overwrite each
  // other's script between runs.
  const helperFile = `${runHelperPath}-${instanceId}${extension}`;
  const sessionSetupFile = `${runHelperPath}-${instanceId}-session.ps1`;
  const cwdHash = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  const argsPath = `${runHelperPath}-${cwdHash}${extension}.args`;
  const markerPath = path.join(
    path.dirname(runHelperPath),
    `exit-${randomUUID()}.marker`
  );
  const setupMarkerPath = path.join(
    path.dirname(runHelperPath),
    `setup-${randomUUID()}.ready`
  );
  const args = runArguments(editorDocument, projectPath);

  try {
    await cleanStaleFiles();
    await fs.mkdir(path.dirname(runHelperPath), { recursive: true });
    await fs.writeFile(
      helperFile,
      buildRunScript(shell, cwd, args, markerPath, argsPath),
      "utf8"
    );
    if (shell === "powershell") {
      await fs.writeFile(
        sessionSetupFile,
        buildPowerShellSessionSetup(helperFile, setupMarkerPath),
        "utf8"
      );
    }
  } catch (error) {
    terminal.show();
    void showError(
      `Could not prepare the C# run helper: ${errorMessage(error)}`
    );
    return;
  }

  const command = buildRunCommand(shell, helperFile);
  scriptMarkerPath = markerPath;
  lastMarkerPath = markerPath;
  updateRunUi(true);

  try {
    const shellIntegration = await waitForShellIntegration(terminal, 3000);
    log(`shell integration ${shellIntegration ? "available" : "unavailable"}`);
    if (sequence !== runSequence) {
      terminal.show();
      return;
    }
    if (!terminalPromptReady) {
      await setShortTerminalPrompt(
        terminal,
        shellIntegration,
        shell,
        helperFile,
        sessionSetupFile,
        setupMarkerPath
      );
      terminalPromptReady = true;
      log("terminal prompt/helper setup done");
    }
    terminal.show();
    if (terminalWasCreated && groupCountBeforeOpening === 1) {
      const panelWidth = settings.get<number>("panelWidth", 35);
      try {
        await vscode.commands.executeCommand("vscode.setEditorLayout", {
          orientation: 0,
          groups: [{ size: 1 - panelWidth / 100 }, { size: panelWidth / 100 }]
        });
      } catch (error) {
        void showWarning(
          `Could not apply the requested terminal width: ${errorMessage(error)}`
        );
      }
    }
    if (sequence !== runSequence) {
      return;
    }
    if (!isTerminalAlive(terminal)) {
      resetTerminalState();
      void showWarning(
        "The C# Quick Run terminal was closed before the run started. Run again to open a new one."
      );
      return;
    }
    runCommandLine = command;
    runEndedSinceStart = false;
    if (shellIntegration) {
      try {
        activeExecution = shellIntegration.executeCommand(command);
        log(`command sent via shell integration: ${command}`);
      } catch {
        terminal.sendText(command);
        activeExecution = undefined;
      }
    } else {
      terminal.sendText(command);
      activeExecution = undefined;
    }
    void monitorRunCompletion(markerPath, sequence);
  } catch (error) {
    terminal.show();
    if (sequence === runSequence) {
      updateRunUi(false);
      void showError(
        `Could not start the C# run: ${errorMessage(error)}`
      );
    }
  }
}

function stopCurrentRun(): void {
  log(`stop command invoked (active ${isRunActive}, terminal ${runTerminal ? (isTerminalAlive(runTerminal) ? "alive" : "dead") : "none"})`);
  if (runTerminal && !isTerminalAlive(runTerminal)) {
    resetTerminalState();
    return;
  }
  if (!runTerminal) {
    // No terminal to interrupt: make sure the UI cannot stay stuck on Stop.
    runSequence++;
    updateRunUi(false);
    return;
  }
  if (!isRunActive) {
    return;
  }

  log("stop requested: sending Ctrl+C");
  runSequence++;
  activeExecution = undefined;
  runTerminal.sendText("\u0003");
  updateRunUi(false);
}

function updateRunUi(active: boolean): void {
  isRunActive = active;
  if (!runStatus) {
    return;
  }

  runStatus.text = active
    ? "$(sync~spin) $(primitive-square) Stop C# Quick Run"
    : "$(play) C# Quick Run";
  runStatus.tooltip = active
    ? "Stop the current C# run"
    : "Run the current C# file or project (Alt+F5)";
  runStatus.command = active
    ? "csharpInlineLaunchPad.stop"
    : "csharpInlineLaunchPad.run";
  runStatus.color = active ? "#FF7777" : "#9AE878";
}

function getRunTerminal(cwd: string): vscode.Terminal {
  if (runTerminal && !isTerminalAlive(runTerminal)) {
    runTerminal = undefined;
    terminalPromptReady = false;
    activeExecution = undefined;
    lastMarkerPath = undefined;
  }
  if (!runTerminal) {
    runTerminal = vscode.window.createTerminal({
      name: runTerminalName,
      cwd: vscode.Uri.file(cwd),
      location: { viewColumn: vscode.ViewColumn.Beside }
    });
  }
  return runTerminal;
}

async function setShortTerminalPrompt(
  terminal: vscode.Terminal,
  shellIntegration: vscode.TerminalShellIntegration | undefined,
  shell: ShellKind,
  helperFile: string,
  sessionSetupFile: string,
  setupMarkerPath: string
): Promise<void> {
  const promptCommand =
    shell === "powershell"
      ? `. '${escapePowerShell(sessionSetupFile)}'`
      : shell === "cmd"
        ? `prompt $G$S & ${buildHelperDefinition(shell, helperFile)} & cls & >"${setupMarkerPath}" echo ready`
        : `${buildHelperDefinition(shell, helperFile)}; clear; : > ${quoteShellArgument(shell, setupMarkerPath)}`;

  try {
    if (shellIntegration) {
      shellIntegration.executeCommand(promptCommand);
    } else {
      terminal.sendText(promptCommand);
    }
  } catch (error) {
    void showWarning(
      `Could not initialize the terminal prompt through shell integration: ${errorMessage(error)}`
    );
    terminal.sendText(promptCommand);
  }

  const setupCompleted = await waitForMarker(setupMarkerPath, 3000);
  log(`terminal setup ${setupCompleted ? "confirmed" : "timed out"}`);
  if (!setupCompleted) {
    void showWarning(
      "The terminal setup did not confirm completion; showing it and continuing."
    );
  }
}

function runArguments(
  document: vscode.TextDocument,
  projectPath: string | undefined
): string[] {
  return projectPath
    ? ["run", "-v", "q"]
    : ["run", path.basename(document.uri.fsPath)];
}

// Arguments typed after `r`/`run` are passed to the program after `--` and
// remembered per project folder in argsPath. A bare `r` reuses them, and a
// lone `--` clears them.
function buildRunScript(
  shell: ShellKind,
  cwd: string,
  args: string[],
  markerPath: string,
  argsPath: string
): string {
  if (shell === "powershell") {
    const dotnetArgs = args.map((argument) => `'${escapePowerShell(argument)}'`).join(", ");
    return [
      `Set-Location -LiteralPath '${escapePowerShell(cwd)}'`,
      `$argsFile = '${escapePowerShell(argsPath)}'`,
      "if ($args.Count -eq 1 -and $args[0] -eq '--clear') { $runArgs = @(); Set-Content -LiteralPath $argsFile -Value '[]' } elseif ($args.Count -gt 0) { $runArgs = @($args); ConvertTo-Json -InputObject $runArgs -Compress | Set-Content -LiteralPath $argsFile } elseif (Test-Path -LiteralPath $argsFile) { $runArgs = @(Get-Content -LiteralPath $argsFile -Raw | ConvertFrom-Json | Where-Object { $null -ne $_ }) } else { $runArgs = @() }",
      "Clear-Host",
      `$dotnetArgs = @(${dotnetArgs})`,
      "if ($runArgs.Count -gt 0) { $dotnetArgs += '--'; $dotnetArgs += $runArgs }",
      // The marker is written in finally so it still appears when Ctrl+C
      // aborts the script; -1 marks a run that was interrupted.
      "$code = -1",
      "try {",
      "  dotnet @dotnetArgs",
      "  $code = $LASTEXITCODE",
      "} finally {",
      `  Set-Content -LiteralPath '${escapePowerShell(markerPath)}' -NoNewline -Value $code`,
      "}",
      'Write-Host "[Exited with code $code]"'
    ].join("\r\n");
  }

  if (shell === "cmd") {
    const dotnet = `dotnet ${args
      .map((argument) => quoteShellArgument(shell, argument))
      .join(" ")}`;
    const argsFile = escapeCmd(argsPath);
    return [
      "@echo off",
      `cd /d "${escapeCmd(cwd)}"`,
      'set "runargs=%*"',
      'set "extra="',
      `if "%runargs%"=="--clear" (type nul > "${argsFile}" & set "runargs=") else if defined runargs (> "${argsFile}" echo %runargs%) else if exist "${argsFile}" (set /p runargs=< "${argsFile}")`,
      'if defined runargs set "extra= -- %runargs%"',
      "cls",
      `${dotnet}%extra%`,
      'set "code=%errorlevel%"',
      'set "runargs="',
      'set "extra="',
      "echo [Exited with code %code%]",
      `> "${escapeCmd(markerPath)}" echo %code%`
    ].join("\r\n");
  }

  const dotnet = `dotnet ${args
    .map((argument) => quoteShellArgument(shell, argument))
    .join(" ")}`;
  const argsFile = quoteShellArgument(shell, argsPath);
  return [
    `cd ${quoteShellArgument(shell, cwd)} || return`,
    `if [ "$#" -eq 1 ] && [ "$1" = "--clear" ]; then : > ${argsFile}; elif [ "$#" -gt 0 ]; then printf '%s\\n' "$@" > ${argsFile}; fi`,
    "__runargs=()",
    `if [ -f ${argsFile} ]; then while IFS= read -r __line; do __runargs+=("$__line"); done < ${argsFile}; fi`,
    "clear",
    `if [ "\${#__runargs[@]}" -gt 0 ]; then ${dotnet} -- "\${__runargs[@]}"; else ${dotnet}; fi`,
    "code=$?",
    "unset __runargs __line",
    `printf '[Exited with code %s]\\n' "$code"`,
    `printf '%s' "$code" > ${quoteShellArgument(shell, markerPath)}`
  ].join("\n");
}

function buildHelperDefinition(shell: ShellKind, helperFile: string): string {
  if (shell === "cmd") {
    return `doskey r=call "${helperFile}" $* & doskey run=call "${helperFile}" $*`;
  }
  const source = `source ${quoteShellArgument(shell, helperFile)} "$@"`;
  return `r() { ${source}; }; run() { ${source}; }`;
}

function buildPowerShellSessionSetup(
  helperFile: string,
  setupMarkerPath: string
): string {
  return [
    // The prompt is left alone: replacing it removes the shell integration
    // sequences VS Code uses to detect when a command has finished.
    "Remove-Item Alias:r -ErrorAction SilentlyContinue",
    `function global:r { & '${escapePowerShell(helperFile)}' @args }`,
    `function global:run { & '${escapePowerShell(helperFile)}' @args }`,
    "Clear-Host",
    `Set-Content -LiteralPath '${escapePowerShell(setupMarkerPath)}' -NoNewline -Value ready`
  ].join("\r\n");
}

function buildRunCommand(shell: ShellKind, helperFile: string): string {
  if (shell === "powershell") {
    return `& '${escapePowerShell(helperFile)}'`;
  }
  if (shell === "cmd") {
    return `call "${helperFile}"`;
  }
  return `source ${quoteShellArgument(shell, helperFile)}`;
}

function isRunAlias(commandLine: string): boolean {
  return /^(r|run)(\s|$)/i.test(commandLine.trim());
}

function getShellKind(terminal: vscode.Terminal): ShellKind {
  const detectedShell =
    terminal.state.shell ??
    vscode.workspace
      .getConfiguration("terminal.integrated")
      .get<string>(`defaultProfile.${process.platform === "win32" ? "windows" : process.platform}`);
  const shellName = path.basename(detectedShell ?? "").toLowerCase();

  if (shellName.includes("cmd")) {
    return "cmd";
  }
  if (
    shellName.includes("powershell") ||
    shellName === "pwsh" ||
    shellName.startsWith("pwsh.")
  ) {
    return "powershell";
  }
  if (process.platform === "win32" && !shellName) {
    return "powershell";
  }
  return "bash";
}

function waitForShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number
): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) {
    return Promise.resolve(terminal.shellIntegration);
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (integration: vscode.TerminalShellIntegration | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      integrationListener.dispose();
      closeListener.dispose();
      resolve(integration);
    };

    const integrationListener =
      vscode.window.onDidChangeTerminalShellIntegration((event) => {
        if (event.terminal === terminal) {
          finish(event.shellIntegration);
        }
      });
    const closeListener = vscode.window.onDidCloseTerminal((closedTerminal) => {
      if (closedTerminal === terminal) {
        finish(undefined);
      }
    });
    const timeout = setTimeout(
      () => finish(terminal.shellIntegration),
      timeoutMs
    );
  });
}

// Stops the program still running in the run terminal and waits until its
// marker appears, which only happens after the program has exited. Ctrl+C is
// sent a second time if the first one did not end it.
async function interruptPreviousRun(
  terminal: vscode.Terminal,
  marker: string
): Promise<boolean> {
  const hasExited = async (): Promise<boolean> =>
    runEndedSinceStart || (await fileExists(marker));

  // Ctrl+C is only sent while the program is still running. Sent to an idle
  // shell it is echoed as ^C and does nothing else.
  if (await hasExited()) {
    await fs.unlink(marker).catch(() => undefined);
    if (lastMarkerPath === marker) {
      lastMarkerPath = undefined;
    }
    log("previous run had already exited; no Ctrl+C sent");
    return true;
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    terminal.sendText("\u0003");
    log(`previous run: Ctrl+C (attempt ${attempt})`);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      // Either signal means the old program is gone and the shell is free.
      if (await hasExited()) {
        await fs.unlink(marker).catch(() => undefined);
        if (lastMarkerPath === marker) {
          lastMarkerPath = undefined;
        }
        log("previous run exited");
        return true;
      }
      if (!isTerminalAlive(terminal)) {
        return false;
      }
      await delay(100);
    }
    log(
      `previous run: no exit signal after Ctrl+C (marker ${(await fileExists(marker)) ? "present" : "missing"}, ` +
        `shell returned ${runEndedSinceStart})`
    );
  }
  log("previous run did not exit after two Ctrl+C attempts");
  return false;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function monitorRunCompletion(
  markerPath: string,
  sequence: number
): Promise<void> {
  while (sequence === runSequence) {
    if (!isTerminalAlive(runTerminal)) {
      resetTerminalState();
      return;
    }
    try {
      const exitCode = (await fs.readFile(markerPath, "utf8")).trim();
      await fs.unlink(markerPath);
      if (lastMarkerPath === markerPath) {
        lastMarkerPath = undefined;
      }
      log(`marker detected (exit code ${exitCode}, sequence ${sequence})`);
      if (sequence === runSequence && isRunActive) {
        activeExecution = undefined;
        updateRunUi(false);
      }
      return;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        await delay(250);
        continue;
      }

      void showWarning(
        `Could not read the C# run completion marker: ${errorMessage(error)}`
      );
      return;
    }
  }
}

async function waitForMarker(
  markerPath: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await fs.unlink(markerPath);
      return true;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        await delay(50);
        continue;
      }
      throw error;
    }
  }

  return false;
}

async function findNearestProject(
  startDirectory: string
): Promise<string | undefined> {
  let directory = startDirectory;

  while (true) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const project = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".csproj"))
      .map((entry) => entry.name)
      .sort()[0];

    if (project) {
      return path.join(directory, project);
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

function quoteShellArgument(shell: ShellKind, argument: string): string {
  if (shell === "powershell") {
    return `'${escapePowerShell(argument)}'`;
  }
  if (shell === "cmd") {
    return `"${escapeCmd(argument)}"`;
  }
  return `'${argument.replaceAll("'", "'\\''")}'`;
}

function escapePowerShell(value: string): string {
  return value.replaceAll("'", "''");
}

// Percent signs are expanded inside batch files, so double them.
function escapeCmd(value: string): string {
  return value.replaceAll("%", "%%");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingDotnet(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
