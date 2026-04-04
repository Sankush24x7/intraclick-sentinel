# IntraClick Sentinel

Internal-use Chrome extension to capture click-by-click evidence with screenshots and export to a Word report.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-orange)
![Version](https://img.shields.io/badge/version-1.0.0-blue)

## What This Extension Does

IntraClick Sentinel helps QA, support, and internal teams document workflows by capturing screenshots on every click.

Key behavior:
- Captures screenshots for each click while recording is active.
- Supports main tab and linked popup windows of the same web flow.
- Adds a diagonal watermark (`IntraClick Sentinel`) on each screenshot.
- Shows captures in side panel with notes.
- Exports all captures to a `.doc` Word file with metadata.

## Main Features

- Side panel controls: `Start`, `Pause/Resume`, `Stop`, `Export Word`, `Clear All`, `Close Panel`.
- Session details (toggle): Tester, Module, Ticket ID, Environment, Build Version.
- Previous Screenshots popup viewer with scroll.
- Reverse export timer in panel.
- Auto-stop recording when panel is closed.
- Sensitive-field redaction support for common fields (password/OTP/card-like).

## How It Works

1. Open extension side panel.
2. Click `Start`.
3. Perform actions on webpage (and linked popups).
4. Each click creates one screenshot entry.
5. Optionally add note per screenshot.
6. Click `Stop`.
7. Click `Export Word` to download evidence report.

## Local Setup (Unpacked Extension)

1. Clone/download this repository.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select this project folder (the folder containing `manifest.json`).
6. Pin extension and click it once to open side panel.

## Project Structure

- `manifest.json` - Extension config and permissions.
- `background.js` - Recording sessions, tab linking, screenshot capture, watermark, export.
- `content.js` - Click detection and sensitive-area metadata collection.
- `sidepanel.html` - Panel UI.
- `sidepanel.js` - Panel behavior, controls, notes, modal, timer.
- `sidepanel.css` - UI styling.
- `icons/` - Extension icons.

## Permissions Used

- `activeTab` - Work with currently active tab when extension is used.
- `tabs` - Tab metadata, popup linkage, capture support.
- `scripting` - Inject/ensure content script when needed.
- `downloads` - Save Word report file.
- `sidePanel` - Display extension side panel UI.
- `storage` - Reserved for local extension state enhancements.
- `host_permissions: <all_urls>` - Detect and capture clicks on internal web apps.

## Export Format

Export creates a `.doc` file (HTML-based Word document) containing:
- Session details
- Start/stop timestamps
- Step-by-step screenshots
- Click metadata (area/tag/url/time)
- Notes per step

## Troubleshooting

If clicks are not captured:
- Refresh target webpage once and click `Start` again.
- Confirm side panel is open in the same browser window.
- Verify you are clicking in the recorded tab or linked popup.

If popup clicks are not captured:
- Start recording from parent tab first.
- Open popup from that tab (same flow).
- Keep extension loaded after latest code update and reload extension if needed.

If export says no screenshots:
- Ensure at least one screenshot is visible in panel.
- Try `Stop` then `Export Word`.
- Reload extension after updates.

## Security and Privacy Notes

- Intended for internal use.
- Screenshots may contain sensitive information visible on page.
- Review exported files before sharing.
- Limit usage to approved internal domains/environments.

## Development Notes

- Manifest Version: `3`
- Extension Name: `IntraClick Sentinel`
- Current Version: `1.0.0`

## GitHub Repo Name Ideas

Recommended:
- `intraclick-sentinel`

More options:
- `click-evidence-captor`
- `qa-click-trace-reporter`
- `click2doc-sentinel`
- `webflow-evidence-recorder`

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
