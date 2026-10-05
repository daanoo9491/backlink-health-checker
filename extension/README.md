# LinkLedger SEO – Google index helper

A Chrome extension that checks whether backlinks are on Google by searching
Google from your own browser, then reports **Indexed / Not indexed** to
LinkLedger SEO. Works for any website; no API key, no Search Console.

## Install (once)

1. In LinkLedger: **Settings → Browser helper → Download the helper**, and unzip it
   (or use this `extension` folder from the source code).
2. In Chrome open `chrome://extensions`, switch on **Developer mode** (top right),
   click **Load unpacked** and choose the unzipped `linkledger-helper` folder.
3. Pin it: puzzle-piece icon → pin **LinkLedger helper**.

## Connect and run

1. LinkLedger → Settings → Browser helper → **Create a connection code**, copy it.
2. Click the helper's icon, paste LinkLedger's address and the code → **Connect**.
3. Press **Start**. Keep Chrome open; results appear on your index checks as it goes.

## How it behaves

- One Google search at a time, 8–16 seconds apart, in a minimised window; at most
  400 searches a day by default (changeable in the popup).
- Searches `site:host/path` for each link (the exact address in quotes when it has a
  `?query`). **Indexed** = Google listed that exact page; **Not indexed** = Google
  answered and it wasn't there. Pages that don't load, or that Search Console already
  answered, aren't searched.
- If Google shows “unusual traffic / I’m not a robot” or its cookie page, the helper
  stops and opens the Google window: answer it yourself, then press **Resume**.
  It never tries to get round Google's checks.
- No internet: it waits and tries again a minute later; links aren't lost.
- It only talks to Google and to your LinkLedger address. The code can be removed in
  Settings at any time.
