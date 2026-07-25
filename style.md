# Patchwork style guide

Visual language used in the Patchwork app. Built for a small dark UI with a
single warm accent. Inspired by sequencer / DAW tooling. Everything here is
plain CSS variables + small components — no framework, easy to drop into any
web app.

---

## Tokens

```css
:root {
  --bg:           #0d0e10;             /* page / outermost background        */
  --panel:        #16181c;             /* primary panel / card background    */
  --panel-edge:   #25282e;             /* visible 1px borders                */
  --panel-edge-2: #1c1e22;             /* subtle separators between rows     */
  --text:         #e8e6df;             /* main text                          */
  --text-dim:     #8a8780;             /* secondary text / labels            */
  --text-faint:   #4a4842;             /* tertiary / disabled hints          */
  --accent:       #ffaa33;             /* the brand orange — used sparingly  */
  --accent-glow:  rgba(255,170,51,.4); /* halo for active accent elements    */
  --danger:       #d6604a;             /* destructive actions / errors       */
}
```

### Color usage rules

- **Backgrounds** layer from `--bg` (page) → `--panel` (cards) → `rgba(0,0,0,.25)`
  (row insets) → `rgba(0,0,0,.4)` (input fields).
- **Borders** are always `--panel-edge` (1px) for cards and `--panel-edge-2`
  for inner row separators.
- **Text** is `--text` for primary content, `--text-dim` for labels/captions,
  `--text-faint` for placeholders / disabled-looking hints.
- **`--accent` is reserved** for things the user actively engages with: the
  currently-selected row, hover/focus highlights, value indicators on knobs.
  Don't paint static decoration orange.
- **`--danger`** is only for destructive actions, error banners, and clear
  warnings. Pair with `rgba(214,96,74,.08–.18)` backgrounds on hover.

### Subtle background gradient

The whole app sits on a fixed body gradient that adds depth without competing:

```css
body {
  background: var(--bg);
  background-image:
    radial-gradient(circle at 20% 0%,   rgba(255,170,51,0.04), transparent 50%),
    radial-gradient(circle at 80% 100%, rgba( 95,187,205,0.03), transparent 50%);
}
```

---

## Typography

- **Font**: JetBrains Mono everywhere (Google Fonts). Mono gives the
  controllers/DAW vibe; numbers line up.
- **Base size**: 13px. Most UI shrinks from there:
  - 14px → h1 / page title
  - 13px → body content, modal titles
  - 11px → buttons, inputs, list rows
  - 10px → form labels (uppercase)
  - 9px → section labels (uppercase + heavy letter-spacing)
- **Letter-spacing**: lowercased headers get `letter-spacing: 0.18em–0.22em`;
  uppercase labels get `0.12em–0.22em`. Body text stays at `0.02–0.04em`.
- **Casing**: section labels and small system labels are `text-transform:
  uppercase`; everything user-facing stays sentence case.

Example label block (used for "MIDI", "Presets", "Sources" group titles):

```css
section h2 {
  font-size: 9px; color: var(--text-dim);
  text-transform: uppercase; letter-spacing: 0.22em;
  font-weight: 500;
}
```

---

## Layout primitives

### Card / panel

```css
.card {
  background: var(--panel);
  border: 1px solid var(--panel-edge);
  border-radius: 5px;
  padding: 14px 20px;
}
```

### Row list (rows separated by 1px panel-edge-2 lines)

```css
.row-list {
  display: flex; flex-direction: column;
  gap: 1px;                                /* visible gap shows panel-edge-2 */
  background: var(--panel-edge-2);
  border: 1px solid var(--panel-edge);
  border-radius: 5px;
  overflow: hidden;
}
.row {
  background: rgba(0,0,0,0.25);
  padding: 8px 10px;
}
```

### Active row marker

Selected rows get a 2px accent stripe down the left and a soft tint. Hover
shows a softer version of the same.

```css
.row              { border-left: 2px solid transparent; }
.row:hover        { background: rgba(255,170,51,0.05); border-left-color: var(--accent); }
.row.active       { background: rgba(255,170,51,0.10); border-left-color: var(--accent); }
.row.active .name { color: var(--accent); }
```

---

## Components

### Buttons

Three styles. Heights: 26px standard, 22px compact (status bar).

```css
button {
  background: rgba(0,0,0,0.4);
  color: var(--text);
  border: 1px solid rgba(255,255,255,0.18);
  border-radius: 4px;
  padding: 0 12px;
  height: 26px;
  font: 11px 'JetBrains Mono', monospace;
  letter-spacing: 0.04em;
  cursor: pointer;
}
button:hover { border-color: rgba(255,255,255,0.35); }

button.accent { color: var(--accent); border-color: rgba(255,170,51,0.45); background: rgba(255,170,51,0.06); }
button.danger { color: var(--danger); border-color: rgba(214, 96, 74,0.35); }
```

#### Icon-only button (`.icon-btn`)

26×26 square; lucide icon centred (14×14, stroke-width 1.8). On hover only the
border/text brightens.

#### Two-click arm pattern for destructive actions

Don't use modal confirms for delete in-app. First click adds `.armed` (rotates
to solid danger background); second click within 2.5s executes; mouseout
de-arms.

### Inputs

Text inputs and selects share the button look: `rgba(0,0,0,0.4)` bg, 1px
white-18% border, 4px radius, 26px height.

### Pill / tag

```css
.pill {
  display: inline-flex; align-items: center; gap: 8px;
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--panel-edge);
  border-radius: 4px;
  background: rgba(0,0,0,0.3);
  color: var(--text-dim);
  font-size: 12px; letter-spacing: 0.03em;
  cursor: pointer;
}
.pill.active { color: var(--accent); border-color: rgba(255,170,51,0.55); background: rgba(255,170,51,0.10); }
.pill.ghost  { border-style: dashed; color: var(--text-faint); background: transparent; }
```

### Badge / chip (smaller pills inside rows)

```css
.chip {
  font-size: 9px;
  padding: 2px 7px;
  border-radius: 10px;
  background: rgba(255,255,255,0.06);
  color: var(--text-dim);
  border: 1px solid rgba(255,255,255,0.08);
}
```

### LEDs / activity dots

8px circle. Off = `--text-faint`; on = `--accent` with a soft glow.

```css
.led { width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); }
.led.on { background: var(--accent); box-shadow: 0 0 6px var(--accent-glow); }
```

Add `.on` for ~90ms on activity (`setTimeout` remove).

### Knob (rotary)

16×16 circle, accent border, indicator line that rotates. Vertical/2D drag
changes value; double-click resets.

```css
.knob {
  position: relative;
  width: 16px; height: 16px;
  border-radius: 50%;
  background: transparent;
  border: 1px solid rgba(255,170,51,0.45);
  cursor: pointer;
  touch-action: none;
}
.knob.dragging { border-color: var(--accent); background: rgba(255,170,51,0.10); }
.knob::after {
  content: "";
  position: absolute; left: 50%; bottom: 50%;
  width: 1.5px; height: 7px;
  background: var(--accent); border-radius: 1px;
  transform-origin: 50% 100%;
  transform: translate(-50%, 0) rotate(var(--ang, 0deg));
}
```

JS maps value (0..max) to angle -135° → +135° via `--ang`.

### VU bar

Thin vertical strip; height driven by dB-converted peak with delta-time decay.

```css
.vu       { position: relative; width: 3px; height: 100%; background: rgba(255,255,255,0.05); border-radius: 1px; overflow: hidden; }
.vu .bar  { position: absolute; bottom: 0; left: 0; right: 0; height: 0%; background: var(--accent); transition: height 0.06s linear; }
```

Map `bar 0%` to `-60 dBFS`, `bar 100%` to `0 dBFS`. Apply attack/release in
dB-space client-side (instant attack, ~24 dB/sec release via rAF loop).

### Modal

Centered card, blurred backdrop, max-width caps:

```css
.modal           { position: fixed; inset: 0; z-index: 100; display: flex;
                   align-items: center; justify-content: center; padding: 20px; }
.modal-backdrop  { position: absolute; inset: 0;
                   background: rgba(0,0,0,0.65); backdrop-filter: blur(4px); }
.modal-panel     { position: relative; background: var(--panel);
                   border: 1px solid var(--panel-edge); border-radius: 10px;
                   box-shadow: 0 30px 60px -20px rgba(0,0,0,0.8);
                   max-height: 85vh; display: flex; flex-direction: column;
                   overflow: hidden; }
.modal-panel.small   { max-width: 420px; }
.modal-panel.medium  { max-width: 720px; }
.modal-panel.large   { max-width: 1000px; }
.modal-header        { display: flex; align-items: center; justify-content: space-between;
                       padding: 14px 18px; border-bottom: 1px solid var(--panel-edge); }
.modal-body          { padding: 16px 18px 18px; display: flex; flex-direction: column; gap: 12px; }
```

### Dropdown / context menu

Same look as the modal — opaque panel, 1px edge, 6px radius. Items are
flex-rows with 16×16 lucide icon, label, optional state on the right.

```css
.menu {
  background: var(--panel);
  border: 1px solid var(--panel-edge);
  border-radius: 6px;
  box-shadow: 0 14px 28px -10px rgba(0,0,0,0.8);
  padding: 4px;
}
.menu-item {
  display: flex; align-items: center; gap: 8px;
  height: 30px; padding: 7px 12px 7px 8px;
  border-radius: 4px;
  color: var(--text); font-size: 11px;
  background: transparent; border: 0; cursor: pointer;
}
.menu-item:hover { background: rgba(255,170,51,0.08); color: var(--accent); }
.menu-item.danger:hover { background: rgba(214, 96, 74,0.12); color: var(--danger); }
.menu-sep { height: 1px; background: var(--panel-edge); margin: 4px 0; }
```

Right-click context menus follow the same component, just positioned at
`{x, y}` and clamped inside the viewport.

### Status bar (footer)

```css
.statusbar {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 16px;
  border-top: 1px solid var(--panel-edge);
  background: rgba(0,0,0,0.25);
  font-size: 10px;
  color: var(--text-dim);
  margin-top: auto;
}
```

### Custom scrollbars

```css
* { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.18) transparent; }
::-webkit-scrollbar         { width: 6px; height: 6px; }
::-webkit-scrollbar-track   { background: transparent; }
::-webkit-scrollbar-thumb   { background: rgba(255,255,255,0.18); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.35); }
```

---

## Iconography

Lucide (https://lucide.dev) for every icon. Defaults:

- 14×14, `stroke-width: 1.8` for buttons
- 16×16 in menu items
- 12×12 inside chips / VU widgets
- Color inherits from the parent button/text. Use `--accent` for active state.

Add icons inline with `<i data-lucide="name"></i>` and call
`lucide.createIcons()` after DOM updates.

---

## Animation & feedback

- Hover transitions: short (`0.08–0.12s`) on `background`, `color`,
  `border-color`. No animation on text/font.
- Activity LEDs: snap on, fade to off via JS-driven class removal after
  ~90ms (cheaper than CSS keyframes, easier to retrigger).
- Knob/VU updates: keep DOM cheap, drive `transform` / `height` only. Decay
  in a single `requestAnimationFrame` loop in JS, not per-element CSS.

---

## Layout shell

```
┌ titlebar (drag, menus, undo/redo, window controls) ────────────────────┐
│                                                                        │
│ patchset bar (sticky)                                                  │
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ sources rail (left)  │  preset list (right)                        │ │
│ └────────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│ status bar (MIDI LEDs, panic, tempo)                                   │
└────────────────────────────────────────────────────────────────────────┘
```

### Custom titlebar (frameless window)

In Electron/WebView2 contexts:

```css
.titlebar { -webkit-app-region: drag; app-region: drag; user-select: none; }
.titlebar .no-drag,
.titlebar button,
.titlebar input { -webkit-app-region: no-drag; app-region: no-drag; }
```

For desktop hosts that don't pass per-pixel transparency through to the
underlying window, you may need to send native drag/min/max/close commands
yourself (in Patchwork: `window_move_by`, `window_minimize`, etc).

---

## Interaction patterns

- **Hover ≠ commit.** Use hover only to hint actions, not to fire them.
- **Click for primary action**; right-click opens a context menu with the
  same actions exposed as labels. Double-click reserved for direct edit
  (rename in place, knob reset, edit-source).
- **Drag-and-drop**: pill onto row to link. Show dashed outline on potential
  drop targets while a drag is in progress; solid accent border on the row
  the pointer is over.
- **Inline rename** instead of modal prompts: swap label for input on
  rename action; commit on blur / Enter, cancel on Escape.
- **Undo everything that matters**: every mutating command snapshots
  settings; Ctrl-Z / Ctrl-Shift-Z.
- **Live vs commit**: continuous controls (knobs, sliders) send live deltas
  for audio/visual feedback but only persist on release.
- **Tooltips minimal**: only when the icon alone is ambiguous. Use the
  native `title=` attribute, not a custom JS tooltip.

---

## Don'ts

- Don't use bright/saturated colors apart from `--accent` and `--danger`.
- Don't introduce more typefaces; mono carries the look.
- Don't use rounded-pill chrome (`border-radius: 99px`) — corners stay 4–10px.
- Don't animate width/height except for VU/knob value mapping.
- Don't add native browser `alert/prompt/confirm` dialogs; use inline
  patterns or themed modals.
- Don't show on/off state with colored backgrounds where a single accent
  border already does the job.
