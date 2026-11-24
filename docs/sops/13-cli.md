# SOP 13 — The swap tool

Browsers flag `btq-htlc.mjs` because `.js` and `.mjs` are on the dangerous-download list. The file is the CLI. The warning is the type, not a verdict you clear by re-hosting the same bytes on this IP.

npm and a signed binary are not set up. Do not publish the package, and do not build an unsigned `.exe`. An unsigned executable gets a SmartScreen warning that is worse.

## What to tell the person

They download it from a terminal, which does not apply the browser type block:

```sh
curl -fsSLO http://<host>:5173/downloads/btq-htlc.mjs
node btq-htlc.mjs
```

Node 20 or newer. The file has to stay named `btq-htlc.mjs` because the help text calls that name. Their key stays in `~/.btq-htlc/key.json` on their machine.

## Check the file the server is actually sending

On the workstation, from the repo that was deployed (the SHA in `/opt/btq-swap/REVISION`):

```bash
node packages/htlc/scripts/bundle.mjs
sha256sum packages/htlc/dist/btq-htlc.mjs
```

On the box:

```bash
sha256sum /opt/btq-swap/packages/htlc/dist/btq-htlc.mjs
curl -fsS -D - -o /tmp/btq-htlc.mjs http://127.0.0.1:5173/downloads/btq-htlc.mjs
sha256sum /tmp/btq-htlc.mjs
```

Pass: the two hashes match, the response is `200`, `Content-Type` is `application/javascript`, and `Content-Disposition` is `attachment; filename="btq-htlc.mjs"`. A mismatch means the web image is older or newer than the tree. That is a deploy (SOP 03) only when the request already asked to ship. Otherwise report the two hashes and stop.

Give the person the hash so they can compare. Do not tell them to disable browser protection.
