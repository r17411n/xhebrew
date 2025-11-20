# xhebrew — simple X/Twitter text replacer

This Firefox extension performs simple find & replace on X/Twitter pages using a configurable mapping list.

Install (temporary) in Firefox for testing:

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click "Load Temporary Add-on" and select the extension folder's `manifest.json` (or open the folder and choose the manifest file).
3. Visit `https://twitter.com` or `https://x.com` and the content script will run.

Usage:
- Has functionality to translate hebrew tweets through Google Translate(via the options screen)
- Open the extension options (from the Add-ons page or open `options.html` via the manifest) to edit mappings.
- In the options page, add mappings. Use `/pattern/flags` syntax for regex (for example `/שלום/gi`). Plain strings are treated as literal matches.

Notes:
- This is a minimal example: it replaces text nodes and observes DOM mutations. It avoids script/style nodes.
- If you need advanced behavior (replace inside attributes, handle shadow DOM, performance tuning), I can extend it.
