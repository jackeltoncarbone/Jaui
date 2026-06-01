## Jaui.VSCode

Home for VS Code editor support for Jaui — currently one extension (`Jss.Language`) that gives `.jss` files syntax highlighting. Future siblings (e.g. `Jaui.Language` for `.jaui` files, snippet packs, hover docs) live in this folder as additional extension directories.

## Layout

Each immediate subdirectory containing a `package.json` is one VS Code extension and gets installed as a single unit. Vertical-sliced per Jaui convention — everything for one feature lives in one PascalCase folder, no `syntaxes/` / `src/` / etc. subdirs:

```
Jaui.VSCode/
├── AGENTS.md                           this file
├── Install-Extensions.ps1              junctions every extension into ~/.vscode/extensions/
└── Jss.Language/                       .jss syntax extension
    ├── package.json                    manifest (filename fixed by npm/VS Code)
    ├── Jss.Language.Configuration.json brackets, comments, auto-close
    └── Jss.TmLanguage.json             TextMate grammar — the colorizer
```

Note: `package.json` is the only file whose name is locked (npm + VS Code spec). Everything else mirrors the folder name, matching how the rest of the Jaui repo names sibling files (`Jinput/Jinput.jss`, `Glass/Glass.Material.ts`).

## Install

From a regular (non-elevated) PowerShell:

```powershell
& "<repo>\ShowStudio.Web\Jaui\Jaui.VSCode\Install-Extensions.ps1"
```

The script creates a directory junction for each extension folder into `%USERPROFILE%\.vscode\extensions\`. Junctions don't need admin or Developer Mode, and because they're live pointers, edits to the source files here flow through to the live extension without a reinstall.

VS Code picks up newly-installed extensions on its own — no forced restart. Open a `.jss` file and the status bar (bottom-right) should read **JSS**. If it doesn't, the cheapest nudge is opening a new VS Code window pointed at the same workspace, or `Ctrl+Shift+P` → "Developer: Reload Window" (but try opening a `.jss` file first — usually unnecessary).

## File icon (optional)

VS Code only renders file icons from the active File Icon Theme. For Material Icon Theme users, add to the consumer repo's `.vscode/settings.json`:

```json
{
  "material-icon-theme.files.associations": { "*.jss": "css" }
}
```

## JSS grammar — extending the colorizer

All token rules live in `Jss.Language/Jss.TmLanguage.json`. The grammar is a top-level `patterns` list that delegates to entries in `repository`. Major tokens:

| Token                                     | Repository key         | Example                       |
| ----------------------------------------- | ---------------------- | ----------------------------- |
| Line / block comments                     | `comments`             | `// note`                     |
| Variable declaration                      | `variable-declaration` | `@ScreenR: 80pt`              |
| At-rule block (`@Transition`, etc.)       | `at-rule-block`        | `@Transition Opacity { ... }` |
| Selector + inheritance                    | `selector-block`       | `Foo : Bar { ... }`           |
| Property name + value                     | `property`             | `BorderRadius: 24pt`          |
| Numbers with units (`pt`, `ms`, `%`, ...) | `number-with-unit`     | `220ms`                       |
| `rgba(...)` / `hsl(...)` / etc.           | `function`             | `rgba(0,0,0,0.18)`            |
| Hex colors                                | `hex-color`            | `#ff00aa`                     |
| Variable refs                             | `variable-ref`         | `@ScreenR`                    |
| PascalCase enum values                    | `enum-value`           | `Column`, `Hidden`            |

To add a token type: add an entry to `repository`, then `{ "include": "#new-key" }` into the appropriate parent (`#value`, `#block`, or top-level `patterns`).

To debug a colorization: in VS Code, `Ctrl+Shift+P` → **Developer: Inspect Editor Tokens and Scopes**, then click a token in a `.jss` file. The popup shows which grammar rule matched.

## For agents extending this project

When asked to add features (more languages, snippet packs, formatters):

1. **One extension per top-level PascalCase folder.** Each folder containing a `package.json` becomes one VS Code extension; `Install-Extensions.ps1` auto-discovers them, no script edit needed.
2. **Vertical slicing.** All files for one extension live flat in its folder, named with the folder prefix (`Jss.TmLanguage.json`, not `syntaxes/grammar.json`). Matches the rest of Jaui.
3. **No build step for grammar-only extensions** — they're pure JSON, run as-is. No `npm install`, no compile.
4. **Grammar regex is double-escaped.** JSON-inside-TextMate means `\\b` in the file becomes `\b` in the actual regex.
5. **Don't force a VS Code restart in workflows.** Junctions are live; VS Code typically picks up grammar edits automatically when a `.jss` file is opened or focused. Mention "Reload Window" only as fallback advice.

## JSS language reference (for grammar contributors)

JSS is Jaui's stylesheet format. Files use `.jss`. Examples live throughout `ShowStudio.Web/**/*.jss` and `ShowStudio.Web/Jwift/**/*.jss`. Full spec in this repo's `Styling.md`.

Currently-supported syntax (covered by the grammar):

- **No semicolons.** Properties are newline-terminated.
- **PascalCase keys and values.** `Direction: Column`, not `direction: column`.
- **Class names PascalCase.** `Jwift_Card { ... }`.
- **Inheritance via `:`** — `Child : Parent { ... }`. Disambiguated from property `:` by lookahead for `{`.
- **Variables**: declared `@Name: value` at top level, referenced `@Name` in value position.
- **At-rule blocks**: `@Transition Opacity { Duration: 220ms }`. The at-rule keyword can take an identifier parameter before the block.
- **Comments**: `//` line, `/* */` block.
- **Units**: `pt` (canonical), `ms`, `s`, `%`, `px`, `deg`.

Planned syntax from `Styling.md` not yet in the grammar (good candidates for the next iteration):

- `@style Name { ... }` reusable mixins with multi-inheritance `: Base1, Base2`
- `@spring Property { Stiffness, Damping }` animation declarations
- `@when Condition { ... }` inline responsive breakpoints
- `@var Name: value` typed variable form (alongside current `@Name: value`)
- Material literal values: `LiquidGlass`, `SolidGlass`
- Computed keywords: `concentric` in `BorderRadius: concentric`
