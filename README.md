# MathX Test Series — JEE Main & Advanced mock-exam portal

A complete online examination platform with:

- Google sign-in.
- A question bank for Physics, Chemistry and Mathematics.
- A computer-based-test (CBT) exam room with a server-enforced timer.
- Automatic scoring with configurable marking schemes.
- Solutions and analytics.
- A PDF knowledge base.
- A hybrid AI paper generator that uses your bank first and writes new questions only for the gaps.
- **Every student can make their own practice paper** (bank first, AI for the gaps, with a daily limit per student). Only that student can see the paper and their marks.
- **Shared study material:** any user can upload PDFs; they are shared with everyone for making papers.

Runs on **Neon** (database, sign-in, file storage, server function) and **Firebase Hosting** (website), both on free plans.

Independent practice platform — not affiliated with NTA, the IITs or any examination authority. The name is set by `VITE_APP_NAME`.

---

## Architecture

```
 Browser (React + TypeScript, Vite)                      hosted on Firebase Hosting (free Spark plan)
   │  student portal, CBT room, admin panel, PDF text extraction (pdf.js, in the admin's browser)
   │
   ├──► Neon Auth (Google sign-in) ──── issues a short-lived JWT for the signed-in user
   ├──► Neon Data API (Postgres over HTTPS, with that JWT) ── Row Level Security on every table
   │       └─ exam engine as SQL functions: start, autosave, deadline, submit, scoring, release rules
   └──► Neon Function `api` (Node.js)
           ├─ /ai     blueprint → bank search → PDF excerpts → AI provider → validation → drafts
           └─ /files  checks permission in the database, then signs short-lived URLs for
                      Neon Object Storage (private buckets: PDFs, question figures)
```

Key properties:

- **Students never read question tables.** The question paper comes from a SQL function that strips answer keys. Keys, solutions and scores are released only by the server, according to each exam's release rule.
- **The deadline, scoring and attempt rules run inside Postgres.** Changing the computer clock, refreshing, or editing JavaScript cannot add time or change marks.
- **The function acts as the signed-in user.** It verifies the caller's Neon Auth token, then talks to the database through the Data API with that same token, so every security rule still applies. It holds no database superpowers.
- **PDF text is extracted in the admin's browser,** so large textbooks cost nothing to process.
- **The AI provider and model are database settings** (Admin → Settings), so you can change them without rebuilding. The key lives only in the function's environment.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (schema, flows, functions) · [docs/SECURITY.md](docs/SECURITY.md) (protections and honest limits) · [docs/IMPORT_FORMAT.md](docs/IMPORT_FORMAT.md) (bulk question import).

## Folder structure

```
jee-portal/
├─ web/                      React app (student portal + /admin)
├─ db/
│  ├─ migrations/            10 SQL migrations: schema, RLS, exam engine, admin, file rules, reference data
│  ├─ seed.sql               optional sample: 16 verified questions + a published 30-minute test
│  └─ apply.sh               applies everything to your Neon database
├─ functions/
│  ├─ api/                   the Neon Function (AI generation + private files)
│  └─ _shared/               blueprint, validators, safe maths evaluator, prompts, providers (+ tests)
├─ tests/db/                 SQL test suite (runs against a local Postgres with Neon's auth helpers stubbed)
├─ tests/e2e/                full-stack browser tests against a local stand-in for Neon
├─ docs/                     architecture, security, import format, optional cron SQL
├─ firebase.json .firebaserc Firebase Hosting (SPA rewrite + security headers)
└─ .env.example              every setting, public vs server-side clearly separated
```

---

## Setup — what you need to do

You need free accounts at **Neon** and **Firebase**. **Google Cloud** is needed later for branded sign-in. An **AI API key** is optional until you want real generated questions.

The commands use the Neon CLI through `npx neonctl …`; the first time, run `npx neonctl login` to sign in through your browser. Everything can also be done in the Neon Console.

### 1. Create the Neon project

1. Sign up at <https://neon.com> (no card needed).
2. Create a project:
   - Name: `jee-portal`
   - Region: **AWS Asia Pacific (Singapore)**. It is closest to India and supports Functions and Object Storage.

   With the CLI:
   ```bash
   npx neonctl projects create --name jee-portal --region-id aws-ap-southeast-1
   npx neonctl set-context --project-id <the new project id>
   ```

### 2. Turn on sign-in and the Data API — before the database step

In the Console, open your project's **main** branch and do the following:

1. **Auth → Enable Neon Auth.** CLI: `npx neonctl neon-auth enable`.
2. In the Auth settings, **turn off email & password sign-up**, so only Google sign-in remains. The website only offers Google. Leaving password sign-up off means nobody can register through the API with someone else's email.
3. **Data API → Enable**, using **Neon Auth** as the provider. Leave "grant public schema access" **off**; the migrations set exact permissions.
   CLI: `npx neonctl data-api create --auth-provider neon_auth`
4. Note two values for later:
   - The **Auth URL**, from the Auth page.
   - The **Data API URL**, from the Data API page.

### 3. Create the database

Copy the connection string from **Connect** in the Console. Use the `neondb_owner` role. Then, from the repository folder, in Command Prompt, PowerShell or any terminal:

```bash
cd db
npm install
node apply.mjs "postgresql://neondb_owner:…@ep-….ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require" --seed
```

Then open **Data API** in the Console and press **Refresh schema cache**. With the CLI: `npx neonctl data-api refresh-schema`.

- `--seed` adds sample questions and a 30-minute test, so you can try the student side immediately. Leave it off for an empty bank.
- The script stops safely in two cases. If Neon Auth or the Data API isn't set up yet, it says so. If the database was already set up, it changes nothing.
- On Mac/Linux with `psql` installed, `bash db/apply.sh "<connection string>" --seed` does the same.

### 4. Make yourself the administrator

In the **SQL Editor**, before you sign in for the first time:

```sql
insert into app.admin_invites (email) values ('your.email@gmail.com');
```

When you first sign in with that Google account, which has a verified email, you become admin. If you already signed in, use this instead:

```sql
insert into public.user_roles (user_id, role)
select id, 'admin' from public.profiles where email = 'your.email@gmail.com';
```

### 5. Create the private file buckets

```bash
npx neonctl buckets create documents
npx neonctl buckets create question-images
```

Both are private by default. Students only ever get short-lived links to the figures in their own exams.

### 6. Deploy the server function

```bash
cd functions
npm install
npm run build
npx neonctl functions deploy api --src dist/index.mjs --no-bundle \
  --env ALLOWED_ORIGINS=https://YOUR-FIREBASE-PROJECT-ID.web.app,http://localhost:5173
npx neonctl functions get api            # copy its URL
```

Neon automatically gives the function its database, auth, Data API and storage settings. The function starts on the free **mock** AI provider, which makes clearly labelled placeholder questions with no paid calls. To use Claude:

1. Create a key at <https://console.anthropic.com>. API usage is billed separately from any Claude subscription.
2. Redeploy with `--env AI_API_KEY=sk-ant-…`.
3. In the portal, open **Admin → Settings → AI provider** and choose *Anthropic Claude API*:
   - `claude-sonnet-5-5` for quality
   - `claude-haiku-5-5` for the lowest cost

   Enter the prices from Anthropic's current price list.

Any OpenAI-compatible API also works.

### 7. Google sign-in

Google sign-in works straight away using Neon's shared development credentials. The Google consent screen will show Neon's name. For your own branding:

1. In <https://console.cloud.google.com>, open **APIs & Services → Credentials → Create OAuth client ID** and choose type **Web application**.
   - **Authorized redirect URI:** your Auth URL followed by `/callback/google`, for example `https://ep-….neonauth.ap-southeast-1.aws.neon.tech/neondb/auth/callback/google`
2. In Neon, go to **Settings → Auth → OAuth providers → Add**, choose Google, and paste the client ID and secret.
3. In the Google Cloud **OAuth consent screen**, set the app name, support email and your domain, then publish it.

Either way, add your site to Neon Auth's **trusted domains**:
- `https://YOUR-FIREBASE-PROJECT-ID.web.app`
- `http://localhost:5173`

With the CLI: `npx neonctl neon-auth domain add https://YOUR-FIREBASE-PROJECT-ID.web.app` and `npx neonctl neon-auth domain allow-localhost`.

### 8. Run locally

```bash
cd web
cp .env.example .env.local     # paste the Auth URL, Data API URL and function URL
npm install
npm run dev                    # http://localhost:5173
```

### 9. Deploy the website to Firebase Hosting (free Spark plan)

1. Create a project at <https://console.firebase.google.com>. Stay on Spark; there is no need for Blaze.
2. Put its project ID into `.firebaserc`.
3. Build with `web/.env.local` in place and deploy:

```bash
cd web
npx firebase-tools login
npm run deploy                 # builds, then: firebase deploy --only hosting
```

Your site will be at `https://YOUR-FIREBASE-PROJECT-ID.web.app`.

---

## Costs (as of October 2026 — check current pricing before relying on it)

| Service | Plan | Cost | Notes |
|---|---|---|---|
| Neon | Free | Free | Per project: 1 GB database, 100 compute-hours a month, 5 GB transfer, Neon Auth up to 60,000 monthly users, 5 GB object storage, and Functions with 1 million calls. The database sleeps after 5 minutes idle, so the first request after a break takes a second to wake it. If a monthly limit is hit, the project pauses until the next month; no data is lost. Paid plans lift the limits. |
| Firebase Hosting | Spark | Free | Static website only. |
| Google OAuth | — | Free | |
| AI generation | Pay per use | Only when you generate | With default settings, a full 75-question paper with no bank matches is roughly **$1 on Claude Sonnet 5.5** ($2 / $10 per million input/output tokens) or **~$0.05 on Haiku 5.5** ($0.10 / $0.50). An estimate is shown before every run, and Settings has a daily question limit and a 30-day budget. |
| OCR for scanned PDFs | — | Not enabled | Scanned PDFs are detected and marked "needs OCR". Run OCR yourself (e.g. `ocrmypdf`) and upload the result. |

Nothing in this repository enables a paid service.

## Updating an existing installation

`db/apply.mjs` only sets up an empty database. When a new migration is added later, open it, copy its contents into the Neon **SQL Editor**, run it, then press **Refresh schema cache** on the Data API page. Run them in order of their file names; each is safe to run again by mistake.

| File | Adds |
|---|---|
| `20261019000009_material_selection.sql` | Choosing which PDFs the AI writes from |
| `20261019000010_student_papers.sql` | Students' own private papers, shared uploads, per-student AI limit |

After a migration that changes the `api` function's behaviour (both of the above), rebuild and redeploy the function as in step 6.

---

## Testing

```bash
bash tests/db/run.sh            # 175 database checks (PostgreSQL 15+ binaries; run as a non-root user)
cd web && npm test              # 35 unit tests
cd functions && npm run typecheck && npm run build
# full-stack browser tests — requirements are listed at the top of tests/e2e/start.sh
E2E_WORK=/tmp/e2e PGRST_BIN=/path/to/postgrest bash tests/e2e/restart.sh && E2E_WORK=/tmp/e2e python3 tests/e2e/e2e.py
```

### Database checks

These run as a non-superuser owner, as on Neon. They cover:

- **Security:** anonymous and student access is refused where it should be. There is no privilege escalation, and an unverified sign-up using the admin's email does not become admin.
- **Exam engine:**
  - The paper never contains keys.
  - Autosave handles ordering and duplicates.
  - The server deadline triggers auto-submit, and submit is idempotent.
  - Scores are exact, including partial credit.
- **Admin rules:** release rules, immutability of published versions, question validation, import and duplicates, assembling from a generation plan, and file access rules.

### Browser tests

These drive the real built website and the real bundled function against a local stand-in for Neon: PostgREST for the Data API, a token issuer for Neon Auth, and an S3 server for storage.

- **Student:** takes a test, refreshes mid-test, answers while offline, submits, and gets the exact expected score.
- **Student's own paper:** makes a paper (bank + mock AI), takes it and sees the result; another student and the admin cannot see it; a student's PDF upload is shared with everyone but only the uploader can delete it.
- **Admin:**
  - Generates, reviews and publishes a paper with the mock provider.
  - Uploads a PDF to storage and indexes it.
  - Writes a question.
- **Access and layout:** students are kept out of admin pages, and the exam room fits a phone screen.

These have not yet been run against Neon itself.
