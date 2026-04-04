# ClickSnap Word Reporter - Launch, Rating, and Security Guide

## Brand Image Upgrade

A new icon pack has been added for Chrome toolbar and store listing:

- `icons/icon16.png`
- `icons/icon32.png`
- `icons/icon48.png`
- `icons/icon128.png`

Manifest is updated with `icons` and `action.default_icon`.

## Is this useful?

### Practical Rating

- **Usefulness:** `8.5/10`
- **Security (current build):** `6.5/10`
- **Production readiness:** `6/10`

### Why useful

- Very fast evidence capture for testers.
- Timestamps + click areas + screenshots help developers reproduce bugs faster.
- Word export is convenient for audit/share with non-technical stakeholders.

## Is it secure right now?

It is reasonably safe for internal testing, but **not yet security-hardened for enterprise/public rollout**.

Current positives:
- No external API calls.
- No remote code loading.
- Data stays local in extension memory until export.

Current risks:
- Captures may include sensitive data visible on screen.
- Broad host access (`<all_urls>`) increases attack surface.
- Exported `.doc` files may contain confidential screenshots.

## How to make it security-proof (recommended hardening)

1. Add domain allowlist
- Capture only on approved domains (for example your QA/UAT domains).

2. Add sensitive-page blocking
- Auto-disable recording on URLs containing `login`, `payment`, `bank`, `admin`, etc.

3. Add screenshot masking
- Blur configurable selectors before capture (for example password fields, account IDs, tokens).

4. Add consent banner + watermark
- Show active capture banner and watermark screenshots with user/time/project.

5. Encrypt exports
- Offer password-protected ZIP export instead of raw `.doc` file.

6. Remove unnecessary permissions
- Keep only strictly required permissions; avoid `tabs` broad use when possible.

7. Add retention policy
- Auto-clear in-memory captures after export and after inactivity timeout.

8. Add audit log (non-sensitive)
- Track start/stop/export events only (without screenshot payload).

9. Enterprise policy support
- Add managed storage options for allowlist, retention, masking policy.

10. Security testing
- Run static scanning, dependency checks, and manual privacy review before store publish.

## How to run in Chrome locally (unpacked)

1. Open `chrome://extensions/`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select folder:

`c:\Users\sak40423\OneDrive - EMPRONC SOLUTIONS PVT LTD\Desktop\Sandeep\Chrome Extension\Extension-4-ClickSnapWord`

## How to make it live in Chrome Web Store

1. Prepare release package
- Ensure manifest version, name, descriptions, icons, and screenshots are finalized.
- Zip contents of `Extension-4-ClickSnapWord`.

2. Open Chrome Web Store Developer Dashboard
- Sign in with your publisher account.

3. Create new item
- Upload ZIP.
- Fill listing details (title, short/long description, category, support email, privacy details).

4. Add privacy disclosures
- Clearly mention screenshot capture behavior and data handling.

5. Submit for review
- Choose `Unlisted` first for controlled rollout, then `Public` after validation.

6. Post-publish checks
- Test install from store link.
- Confirm permissions prompt and behavior in clean browser profile.

## Recommended release plan

1. Internal only (Unlisted)
2. Security hardening sprint
3. Pilot users (small group)
4. Public release