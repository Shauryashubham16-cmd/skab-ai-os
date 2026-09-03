// Loads an HTML fragment from `data-fragment-src` (set on this script's own
// <script> tag) and writes it into the document at exactly this point in
// the parse stream — i.e. behaves identically to the markup having been
// inline in index.html all along.
//
// Why synchronous, and why document.write instead of an async
// fetch()+innerHTML swap: several scripts loaded later in index.html
// (settingsPanel.js, imaginationViewer.js) do plain top-level
// `document.getElementById(...)` calls the moment they're parsed — they
// don't wait for a DOMContentLoaded/ready event. An async fetch would still
// be running when those scripts execute, so every one of those lookups
// would return null and silently break the panel. Synchronous XHR blocks
// the parser exactly like the fragment being written inline would have,
// which is what keeps every later script's assumptions valid without
// having to rewrite them to defer their DOM lookups.
//
// This is only used for same-origin static files served by this app
// (public/overlays/*.html), never for third-party or remote content, and
// only for markup that isn't needed for the very first paint (the boot
// screen and reactor stay fully inline in index.html for exactly that
// reason — see the comments there).
(function () {
  var scriptEl = document.currentScript;
  var src = scriptEl && scriptEl.getAttribute('data-fragment-src');
  if (!src) { console.error('[loadFragment] missing data-fragment-src'); return; }
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', src, false); // deliberately synchronous — see comment above
    xhr.send(null);
    if (xhr.status >= 200 && xhr.status < 300) {
      document.write(xhr.responseText);
    } else {
      console.error('[loadFragment] ' + src + ' returned HTTP ' + xhr.status);
    }
  } catch (err) {
    console.error('[loadFragment] failed to load ' + src, err);
  }
})();
