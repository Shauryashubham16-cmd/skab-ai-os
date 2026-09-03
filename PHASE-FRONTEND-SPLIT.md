# Frontend structure

`public/index.html` is now a thin shell: markup only, plus `<link>`/`<script src>`
tags in the exact order the code used to run in. All CSS and JS content is
byte-identical to what was previously inline — this was a pure extraction,
not a rewrite, specifically to avoid introducing behavior changes in a working
app with no browser available to test against.

```
public/
  index.html          # markup + ordered <link>/<script src> tags only
  styles/
    main.css           # the design system (was the first inline <style>)
  state/
    jarvisState.js      # window.JARVIS bootstrap + auth-aware fetch wrapper
                         # (must load first — everything else reads window.JARVIS)
  services/
    nav.js
    microInteractions.js
    audio/
      waveform.js
      voiceInput.js
      wakeWord.js
  components/
    Core/
      bootScreen.css     # boot/auth screen styles (co-located with its markup)
      clock.js
      chat.js
      history.js
    HUD/
      orbitNodes.js
      reactorTilt.js
      reactorStateMachine.js
      particleField.js
      voiceRing.js
    Terminal/
      terminal.js
    Memory/
      memoryPanel.js
    System/
      weather.js
    Agents/
      agentsContextVision.js   # Agents + Context + Vision + Task-Activity panels
    Imagination/
      imaginationViewer.js
    Vision/    Voice/           # reserved — currently folded into Agents/ and
                                 # services/audio/ respectively; empty for now
```

## Why plain `<script src>`, not ES modules

No `type="module"` and no bundler. Classic (non-module) `<script>` tags loaded
in sequence share one top-level scope in the browser — a `const`/`let`/
`function` declared in one file is visible to every `<script>` after it, the
same way multiple inline `<script>` blocks in one file already behaved. That
means this split changes **where code lives**, not **how it runs**: load
order is preserved exactly, and nothing needed to be turned into an export/
import to keep working.

This was verified three ways before shipping:
1. Every extracted file passes `node --check` on its own (catches unbalanced
   braces/strings/parens — i.e. a cut made mid-statement).
2. A scan for top-level `const`/`let`/`function`/`class` names found no
   collisions across files (which would throw a redeclaration error at
   runtime, since they'd share scope).
3. Total extracted line counts match the original inline blocks exactly
   (2011 JS lines, 1006 CSS lines) — nothing was dropped or duplicated.

## Adding a new component

Drop a new `.js` file in the right folder, add one
`<script src="components/Whatever/thing.js"></script>` line to `index.html`
in the right position (after `state/jarvisState.js`, and after anything it
depends on), and it has the same access to `window.JARVIS` and every
previously-loaded global that an inline block would have had.

## Known limitation

This is a real split, not a build system — there's still no bundler,
minification, or tree-shaking, and 19 separate `<script src>` requests on
load is more round-trips than one inline file. That's an intentional
trade-off to keep the zero-build, "just open index.html" philosophy this
project has had since Phase 1, rather than introducing a build step as part
of this change.
