# Hosted dashboard

Web Bluetooth only runs on an HTTPS page. The Pi serves its dashboard over plain `http://cool-eva.local`, so Bluefy and Chrome need a second copy of `public/` served over HTTPS. That copy is **[https://cool-eva.athegen.com](https://cool-eva.athegen.com)**: GitHub Pages behind a custom domain. It is static files only. Once loaded, it talks to the Pi directly over Bluetooth, and no ride or bike data goes to the host. The iOS app bundles `public/` and needs no host.

## Why a custom domain

The dashboard keeps the Bluetooth access code in `localStorage`, and `localStorage` belongs to an **origin**, not a path. Any page on the same origin can read it.

- `https://<owner>.github.io/cool-eva/` shares its origin with every GitHub Pages site on that account, so the dashboard refuses Bluetooth there with **"Bluetooth needs its own address"**.
- `https://cool-eva.athegen.com` is an origin serving only this dashboard. It is the one HTTPS entry in `HOSTED_BLE_ORIGINS` (`public/lib/ble-origin.js`), and `scripts/ble-check-keys.ts` checks that lookalikes are refused: sibling subdomains, other ports, `http:`, the github.io path and the old Worker origin.
- Changing the domain changes the origin, and the saved code does not move with it. Keep the domain stable.

## One-time setup

Done by whoever owns the repository that runs the workflow and the `athegen.com` DNS:

1. **Pages source:** repository **Settings → Pages → Build and deployment → Source → GitHub Actions**.
2. **DNS:** add a `CNAME` record `cool-eva` → `<owner>.github.io`, where `<owner>` owns that repository. Leave the repository name out, and don't point it at the `*.pages.github.io` name the settings page shows.
3. **Custom domain:** in **Settings → Pages → Custom domain**, enter `cool-eva.athegen.com` and save. A workflow-published site ignores a `CNAME` file, so the setting lives here and not in `public/`.
4. **HTTPS:** once GitHub has checked DNS and issued the certificate (this can take up to a day), tick **Enforce HTTPS**.

## How it deploys

`.github/workflows/pages.yml` uploads `public/` unchanged as the Pages artifact on every push to `main` and on manual dispatch. There is no build step, the same as on the Pi. Actions are pinned by commit SHA. If the repository has Pages turned off, the workflow fails at `configure-pages`: that is the setup above not done yet, not a code fault.

## Leaving Cloudflare

From #330 to this change, the dashboard was the `cool-eva-dashboard` Cloudflare Worker at `https://cool-eva-dashboard.cool-eva.workers.dev`. A second Worker, `cool-eva-keys`, served a browser ride-log key generator. Both are gone from the repository. Recording keys now come only from `scripts/generate-log-key.ts` on a computer ([manual install §3](manual-install.md#3-recording-key--on-your-computer)). The Worker configs, the key page and its checks are in git history at `eecc963`.

Removing the deploy workflow does **not** take down the deployed Workers. Each one keeps serving its last deployment until the Cloudflare account owner deletes it. Do this in order:

1. Merge, then confirm `https://cool-eva.athegen.com` loads and connects over Bluetooth.
2. Delete both Workers in the Cloudflare dashboard. Revoke the Workers API token and delete the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Riders **re-enter their saved Bluetooth access code** at the new address and update their bookmarks. After that they may clear the old site's data in their browser.

Riders' old codes stay in browser storage under the workers.dev origin, as they did under `danieltroger.github.io` before that. So don't deploy another Worker named `cool-eva-dashboard` on that account, or publish another GitHub Pages site on `danieltroger.github.io`, unless the Pi's Bluetooth code has been rotated first.

Sources read: GitHub's [managing a custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site) (the subdomain `CNAME` record, the `CNAME`-file sentence for custom workflows, Enforce HTTPS), and `action.yml` of `actions/upload-pages-artifact` at `fc324d35` (v5.0.0: it archives the `path` input and leaves out `.git`, `.github` and, unless `include-hidden-files` is set, every dotfile; `public/` has none).
