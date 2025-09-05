Schematic Studio — Smoke Test
================================

What this is
------------
A minimal browser-based harness that loads your **index.html** in an iframe and runs
end-to-end checks:

1) App boots and toolbar controls are present.
2) Imports a *synthetic* PNG via the hidden file input.
3) Loads the OpenCV worker.
4) Runs **Adaptive** and verifies the main canvas actually changes.
5) Switches to the **Highlight** tool, draws two strokes with different transparency,
   and verifies the alpha difference on pixels.
6) Triggers **Export SVG** and verifies an SVG blob was created (download intercepted).

How to run
----------
1. Put **smoke-test.html** and **smoke-tests.js** in the *same folder* as your app
   files (**index.html**, **app.js**, **cv-worker.js**, **styles.css**, **sw.js**).
2. Serve over HTTP (e.g., XAMPP/Apache) — do *not* open via file://.
   Example: http://localhost/YourFolder/smoke-test.html
3. Click **Run smoke test**. Results will appear on the right.

Notes
-----
- The test uses a synthetic image drawn in-memory (no external assets).
- It overrides the read-only `input.files` with a `DataTransfer` to simulate a user
  picking a file, then dispatches a `change` event.
- It samples canvas pixels to compute differences; this is a quick heuristic rather
  than a strict visual diff.
- It temporarily intercepts `URL.createObjectURL` inside the iframe to detect
  SVG export without saving a file. The original function is restored afterward.

- The smoke test now exercises CV cleanup buttons: Adaptive, Denoise, Deskew, Auto Clean, and Reset. It verifies canvas pixel changes via checksums.
