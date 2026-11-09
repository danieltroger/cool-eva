# Hosted dashboard and ride recording keys

Two static Cloudflare Workers serve this repository: `cool-eva-keys` serves `workers/keys/public/`; `cool-eva-dashboard` serves `public/` directly. They have separate origins. Neither runs server-side application code or holds a key, database or storage binding. Dashboard traffic goes between the phone and Pi through the existing Bluetooth tunnel.

The addresses are [the key page](https://cool-eva-keys.cool-eva.workers.dev) and [the dashboard](https://cool-eva-dashboard.cool-eva.workers.dev). For [#327](https://github.com/danieltroger/cool-eva/issues/327), the coordinator verified the first deployment of [#330](https://github.com/danieltroger/cool-eva/pull/330), SHA `849ad29`: both pages returned 200, dashboard assets and missing-asset 404 worked, the key security headers were present, and the deploy log was clean. This is the coordinator's deployment observation, not phone acceptance. The later cutover SHA still needs its own deployment verification before Pages is retired.

## Make recording keys

Open [the key page](https://cool-eva-keys.cool-eva.workers.dev) in a supported browser. Tap **Generate keys**, then **Download private key**. Find `ride-log-key.private.pem`, keep a recoverable backup away from the Pi (for example in your password manager), and confirm **I have saved a recoverable copy**. Download `ride-log-key.public.pem`. Only the public file belongs on the Pi. Losing the private key makes old rides unreadable; generating another pair does not recover them. Existing owners can keep their existing keys.

The page reports that a download started. It cannot confirm that the file was saved or backed up. If the pair is still shown when you return to the tab, retrying its private download uses the same pair. Reloading, navigating away or a browser discarding the tab loses it; returning never generates a replacement automatically. Use the files you saved rather than accidentally configuring a different key. A browser download cannot set the CLI's mode 0600. Phone app-switching and file handling remain part of the outstanding acceptance below.

Chrome/Edge 133+, Firefox 130+ and Safari/iOS Safari 17+ support the required X25519 operations. The page attempts generation and export and reports failure if either is unavailable. For an unsupported browser, update it or use the existing Node 24 laptop command:

```sh
node --experimental-strip-types scripts/generate-log-key.ts
```

Both routes produce the same X25519 PKCS#8 private/SPKI public PEM format and filenames. The page never uploads a key, writes it to browser storage, embeds it in a URL or copies it to the clipboard. The private PEM is never rendered. The page uses transient memory and explicit downloads; your device, password manager or backup service may sync files you save. JavaScript cannot guarantee memory erasure. The public fingerprint is lowercase SHA-256 hex of the SPKI DER bytes. This key pair is separate from the dashboard Bluetooth access code.

### Only a phone

On an iPhone use **Safari**; on Android use **Chrome**. When starting in the Cool Eva iOS app, open the key page separately in Safari; the native dashboard's download/share implementation does not establish that Safari's key downloads work.

1. Download the private PEM. Safari on iPhone saves downloads to **iCloud Drive** by default, which may sync the private file to iCloud. Choose **On My iPhone** in Safari's Downloads settings for a local copy. Find the file in **Files → iCloud Drive → Downloads**, or the location you chose. On Android, use **Chrome → Downloads** or your Files app. Find the exact `ride-log-key.private.pem` file and back it up. [Safari download locations](https://support.apple.com/guide/iphone/customize-your-safari-settings-iphb3100d149/ios), [find iPhone downloads](https://support.apple.com/en-us/102440), [Chrome's Android download guide](https://support.google.com/chrome/answer/95759?hl=en&co=GENIE.Platform%3DAndroid).
2. Return to the same browser tab. If the pair is still shown, you can retry its private download before confirming your backup. A browser may suffix repeated filenames, so compare the public fingerprint and keep one known matching pair. If the tab was cleared, use your saved matching files; generating again creates a different pair.
3. Confirm the backup, download the public file, and find `ride-log-key.public.pem` as well. Join the Pi's Wi-Fi network, open its own HTTP dashboard, and use ride recording setup's Browse/Files picker to select **only `ride-log-key.public.pem`**. Never select the private file. Compare the fingerprint, apply the setting and check the active recorder status.

The file-picker flow belongs to [#317](https://github.com/danieltroger/cool-eva/issues/317); verification of the hosted-page handoff to Settings → Ride recording remains outstanding on phones. The HTTPS key page never POSTs to the HTTP Pi or attempts cross-origin installation. Upload the public file through the Pi's own dashboard. The installation guides link to the published key page; no key argument is added to the installer.

## One-time account setup — coordinator only

The author lane must never access a Cloudflare account or token. Daniel authorised the coordinator to set up his **personal** account.

1. **Before creating a token**, confirm both a Cloudflare account display name and a workers.dev subdomain that contain no personal identity. Rename an email-derived default account name and any identifying subdomain first. Wrangler can print the account display name into these public Actions logs on an authentication error; GitHub does not mask that name. The subdomain becomes the permanent public origin. Keep the stable Worker names **`cool-eva-keys`** and **`cool-eva-dashboard`**; CI creates them on first deploy. No reservation, custom domain or DNS change is required.
2. Complete independent diff review of `.github/workflows/workers.yml` before adding deployment credentials. Only after approval and the two naming checks above, create an API token with **Account → Workers Scripts → Edit**, restricted to this one personal account. Use **no TTL/expiration and no IP filter**, so hosted runners and next year's deployment remain usable. Do not grant DNS, Routes, Pages, KV, R2 or general account administration permissions. This is an account-scoped permission, not a restriction to just the two named Workers.
3. After that approval, set GitHub Actions repository secrets **`CLOUDFLARE_API_TOKEN`** and **`CLOUDFLARE_ACCOUNT_ID`**. Never put their values into configs, Git, issues, PRs, receipts, command output or the coordination events file.

Keep both Worker names and the account subdomain stable. Changing either changes the origin and loses the dashboard's stored Bluetooth code at that address. The hosted dashboard address is:

```text
https://cool-eva-dashboard.cool-eva.workers.dev
```

The dashboard can use Bluetooth on any page where the browser provides Web Bluetooth.

The account subdomain is `cool-eva`. Wrangler derives the addresses from each Worker name and this subdomain; the config comments record both canonical origins. The key page is `https://cool-eva-keys.cool-eva.workers.dev`.

**Riders moving from `https://danieltroger.github.io/cool-eva/` must re-enter their saved Bluetooth access code on the new dashboard.** Browser storage is tied to the origin and is not transferred or cleared by unpublishing Pages. Keep a recoverable copy and update bookmarks; after re-entry, you may clear the old site's data in your browser. See the [rotation requirement before reusing that Pages account](ble-server.md#hosted-pages-and-origin-isolation). The bundled native app keeps its existing origin and code.

## CI and local checks

`.github/workflows/workers.yml` uses Node **24**, Actions pinned by full commit SHA, and Wrangler **4.157.0** pinned in `workers/package.json` and its own lockfile. `npm --prefix workers ci` installs development/CI tooling, without changing the Pi application's dependency tree or root lockfile. Do not install it on the Pi.

PR validation has no Cloudflare secrets. Pushes to main, or a manual run on main, validate before deploying both Workers sequentially. A superseded main SHA records a notice and skips the deployment steps without failing the run; fetch/auth/deployment errors still fail. Production deployments are serialised without cancelling a running one, and the two Cloudflare secrets are supplied only to the deployment steps. Formatting belongs to the existing automatic Prettier workflow; it does not block this workflow's deploy gate. An ordinary failed second deploy is visible and can be rerun from main; the two independent Workers are not an atomic pair.

If automatic formatting advances main, its bot commit does not trigger another workflow run. The revision guard skips the older run; manually run **Hosted pages** on main to publish the formatted revision.

All remote deployment happens in GitHub Actions. **Never run laptop `wrangler deploy`, even with `--dry-run`.** Local development uses only `wrangler dev --local`:

```sh
npm ci
npm --prefix workers ci
npm --prefix workers run dev:keys
# In a separate session, if needed:
npm --prefix workers run dev:dashboard
```

The key page is at `http://127.0.0.1:8788`, which browsers treat as a secure context for local development. The dashboard is at port 8787. Both are local previews, with no account login, remote bindings or production access. To run the checks sequentially:

```sh
npm run typecheck
npm test
npm --prefix workers run check
```

The Node-only key check imports the actual page helper, compares its PEM bytes to Node exports, then uses the production recorder and decrypt CLI to restore synthetic readings and reject a different private key. The separate browser smoke check starts both local Workers in turn, verifies real asset bytes/MIME/404s and response headers, exercises the page at 390×844, and checks retry, backup gating, transient lifetime, unsupported generation/export, absence of persistence and a CSP-blocked connection. It captures Blobs at the download boundary; it is not phone download acceptance.

The key page's `_headers` enforces a strict CSP with `connect-src 'none'`, same-origin scripts/styles, no workers, forms, frames or external resources. No reporting endpoint or analytics is enabled. Generation/download makes no application network requests after the static page assets load. Cloudflare receives ordinary page HTTP requests, never key material. The dashboard retains Cloudflare's normal revalidation caching for unchanged, unhashed browser assets and has no key-page CSP applied to it.

There is no cron, scheduled rebuild, credential renewal, certificate renewal or storage migration. The pinned compatibility date does not expire. A later tooling/API failure might prevent a future deployment; it does not expire already-served static assets.

## One-time phone acceptance — outstanding

**iOS Safari and Android Chrome acceptance remain OUTSTANDING for Daniel.** Neither platform has an acceptance receipt yet. Desktop browser checks do not substitute for either platform, and successful hosting does not establish phone download, app-switching or picker behaviour. These checks remain follow-up work through the hosting cutover.

Use **synthetic keys only**. Record the platform/version, each observed result, screenshot paths and the tested main SHA in a private receipt. Missing hardware/emulators are **OUTSTANDING**.

- Inspect the actual key page in light and dark at 390×844 with `innerWidth === 390`; inspect initial, generated/backup and unsupported states. Save screenshots under the worktree's gitignored `.preview-shots/`, without displaying private PEM.
- In **iOS Safari** (Xcode iOS Simulator when installed, otherwise Daniel's real phone), save and find **both named PEM files**, retry the private download without changing the pair, switch to Files and return without silent generation, and select only the public PEM in #317 setup. Record picker integration separately if #317 is unavailable.
- Repeat that acceptance in **Android Chrome**, using an available emulator or Daniel's real phone. Record any unavailable platform as OUTSTANDING for Daniel's one-time check.
- Retrieve the saved synthetic bytes privately and run the production seal/decrypt proof. Never upload a private PEM to the Pi or the hosted page. The local check accepts the two downloaded files:

  ```sh
  node --experimental-strip-types scripts/log-key-roundtrip.ts /path/to/synthetic-private.pem /path/to/synthetic-public.pem
  ```

- Verify both Workers' live static responses and the key security headers after main CI deployment. Record the Actions run URL, successful deployment logs and **the actual deployed SHA**; compare live assets with files at that SHA. A local preview or green PR check does not prove live hosting.
- The iOS project still bundles `../public` and loads `cooleva://app/index.html`; the key assets/toolchain are outside it. A native simulator build checks bundled resources if Xcode is available. It does not replace Safari download testing or prove radio behaviour.

## Ordered cutover and Pages retirement

The hosting PR (#330) deployed both Workers before this cutover. The cutover switches rider links and deletes `.github/workflows/pages.yml`. Deleting that workflow stops future Pages publishing; it **does not remove the existing Pages deployment**. The coordinator merges; the author lane never merges or deploys locally.

1. Merge the cutover and wait for **Hosted pages → deploy** to finish on the **cutover main SHA**. Check that the revision guard did not skip its deploy steps and that both Worker deployments succeeded. If main advanced, verify the newer SHA that contains the cutover instead; dispatch the workflow on main if needed. Record that exact deployed SHA and Actions run URL. A green PR check or the first hosting SHA `849ad29` alone is insufficient.
2. Verify the live dashboard and `app.js` return 200, a missing asset returns 404. Verify the key page still returns 200 with its CSP (`connect-src 'none'`, `worker-src 'none'`), `nosniff`, `no-referrer` and permissions policy. Read the deploy log and record the result. Leave Pages published if deployment or live verification fails.
3. **Only after step 2, the coordinator unpublishes Pages.** The coordinator uses repository admin/maintainer access to open **[repository Settings → Pages](https://github.com/danieltroger/cool-eva/settings/pages)**, opens the menu beside **Your site is live at**, then selects **Unpublish site**. This removes the existing deployment; no replacement Pages workflow is needed. [GitHub's unpublishing instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/unpublishing-a-github-pages-site) explain that a later successful Pages deployment could publish it again, which is why the workflow is removed first.
4. The coordinator checks the former `https://danieltroger.github.io/cool-eva/` URL no longer serves the dashboard and records Pages retirement separately from the Worker deploy. Remind riders to update bookmarks and re-enter their saved Bluetooth code on the Worker origin. No browser-storage transfer or redirect migrates that code.

The normal Pi HTTP route and genuine native origin remain available throughout. Phone download/picker acceptance stays **OUTSTANDING for Daniel** after this hosting switch; it is not implied by the deployment receipt.

Sources read for the design: Cloudflare [static asset routing](https://developers.cloudflare.com/workers/static-assets/), [headers](https://developers.cloudflare.com/workers/static-assets/headers/), [workers.dev addresses](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), [CI secrets](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), and [script deployment permissions](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/); the [X25519 export specification](https://wicg.github.io/webcrypto-secure-curves/#x25519) and [browser compatibility data](https://github.com/mdn/browser-compat-data/blob/main/api/SubtleCrypto.json). These describe platform contracts, not observations of this deployment.
