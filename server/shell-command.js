// Windows needs a shell to launch npm `.cmd` shims (Node refuses to spawn
// them directly). Handing Node an args array with `shell: true` makes it
// join them unescaped (DEP0190): an arg with a space splits, and `| > & ^`
// are parsed by cmd.exe. Build the command line ourselves instead, quoting
// every argument; values that cmd.exe cannot carry safely are refused rather
// than passed through mangled — send those via a file or stdin.
// cmd.exe only expands %NAME% pairs; a lone % (C:\Temp\100%) stays literal.
const CMD_UNSAFE = /["\r\n]|%[^%\s]+%/;
const NEEDS_QUOTES = /[\s&|<>^()!,;=]/;

export function quoteCmdArg(arg) {
  const value = String(arg);
  if (CMD_UNSAFE.test(value)) {
    throw new Error(`Argument cannot be passed safely through cmd.exe: ${JSON.stringify(value.slice(0, 80))}`);
  }
  return value === '' || NEEDS_QUOTES.test(value) ? `"${value}"` : value;
}

// Returns spawn(command, args, { shell }) inputs. `command` is used verbatim
// on Windows so callers may prefix it (e.g. `chcp 65001 >NUL && claude.cmd`).
export function shellSpawnArgs(command, args = []) {
  if (process.platform !== 'win32') {
    return { command, args, shell: false };
  }
  return { command: [command, ...args.map(quoteCmdArg)].join(' '), args: [], shell: true };
}
