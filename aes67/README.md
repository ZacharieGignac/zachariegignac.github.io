# Cisco Codec AES67 Manager (Web)

This folder contains a browser-only edition of the app.

## What changed

- No Electron process.
- No Node/Express background API service.
- Browser connects directly to codec xAPI over `wss://` using JSXAPI.

## Files

- `index.html`: UI shell.
- `style.css`: app styling.
- `app.js`: direct JSXAPI integration and all app logic.
- `vendor/jsxapi.min.js`: browser bundle copied from `jsxapi` package.

## Run locally

Use any static web server from this folder.

Examples:

```powershell
# from repository root
npx serve web
```

or

```powershell
# from repository root
python -m http.server 8080 --directory web
```

Then open the shown URL in your browser.

## Browser/security notes

- Host this page on `https://` or `http://localhost` when possible.
- The codec must be reachable from the browser and allow secure WebSocket access.
- Because this is browser-direct, credentials are used only in the browser session.
