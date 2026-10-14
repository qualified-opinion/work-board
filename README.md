# Work Board

A work board for an accounting practice. It covers recurring jobs (BAS, IAS, bookkeeping, payroll, payroll tax and management reports), the task due for each period, client notes, a task timer, a timesheet with Excel export, and a deadlines calendar.

It is one web page with no build step, hosted free on GitHub Pages at **https://qualified-opinion.github.io/work-board/**. It works on a computer or a phone, and on a phone you can add it to the home screen.

## Where your data lives

Your board is kept in this browser (IndexedDB) on this device. There's no account and no server.

To keep it safe and move it between browsers or PCs, the app backs up to **your Google Drive**:

- **Daily backup.** When you open the board and the last backup is a day or more old, it saves a backup to a **Work Board backups** folder in your Drive. If your Google sign-in from that session has expired, a bar at the top asks you to click **Back up now**. Google needs a click before it signs you in.
- **Back up any time.** Use Settings > **Back up to Google Drive**.
- **Restore on a new browser or PC.** Open the app, go to Settings > **Choose a Drive backup**, pick the latest one and confirm.

Settings also has **Download a copy** and **Choose a file…** to save or restore a backup file without Drive.

The app only asks Google for access to files it creates itself (the `drive.file` permission). It can't see anything else in your Drive.

## Turning on Google Drive backup (one time, about 10 minutes)

The app needs its own Google "OAuth client ID" before it can talk to Drive:

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project, for example **Work Board**.
2. Open **APIs & Services > Library**, search for **Google Drive API** and click **Enable**.
3. Open **APIs & Services > OAuth consent screen** (shown as **Google Auth Platform**). Choose **External**, name the app **Work Board** and enter your email. Under **Audience**, add your Google account as a test user, or click **Publish app**.
4. Open **Credentials > Create credentials > OAuth client ID**. Choose **Web application**. Under **Authorised JavaScript origins**, add `https://qualified-opinion.github.io`, then click **Create**.
5. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`) into `googleClientId` in [`js/config.js`](js/config.js) and commit.

A client ID isn't a secret. Google only accepts it from the origins you listed.

## Optional: sync across devices with Supabase

If you later want the same live board on several devices, rather than restoring from backups, fill in `supabaseUrl` and `supabaseAnonKey` in `js/config.js`:

1. Create a free project at [supabase.com](https://supabase.com) in the Sydney region.
2. In the **SQL Editor**, run [`supabase/schema.sql`](supabase/schema.sql).
3. Under **Authentication > Users**, add yourself with **Auto Confirm User** ticked, and turn off **Allow new users to sign up**.
4. Copy the **Project URL** and **anon public** key from **Project Settings > API**.

## Moving your board from the Claude version

1. In the Claude version, open **Settings** and click **Download a copy**.
2. In this app, open **Settings**, then under **Restore** choose that file and confirm.

The restore brings across clients, recurring jobs, tasks, notes, timesheet entries and settings.

## Running it on your computer

```bash
npm start          # serves the app at http://localhost:8080
npm ci && npx playwright install chromium
npm test           # browser tests: local mode, restore, Drive backup, offline sync
```

## How it's put together

- `index.html` is the whole board: markup, styles and app code.
- `js/backend.js` is the data layer. It provides the small database API the board was written against (`collection`, `doc`, `where`, `get`, `set`, `update`, `delete`, `onSnapshot`). Data is kept in memory and in IndexedDB, and synced to the Supabase `docs` table when keys are set. Changes made offline wait in a queue and are sent once the connection is back.
- `js/backend.js` also answers the board's Google Drive backup calls by talking to the Drive API directly, signed in with Google Identity Services.
- `vendor/supabase.js` is the Supabase JavaScript client (v2.117.3, MIT licence). It's only loaded when Supabase sync is turned on.
- `.github/workflows/pages.yml` publishes the site to GitHub Pages on every push to `main`.
- `.github/workflows/test.yml` runs the tests on every push.
