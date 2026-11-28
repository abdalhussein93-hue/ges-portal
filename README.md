# GES Operations Portal

One live web portal for the Global Emirates Services apps. Sign in once, pick an app:

| App | What it does |
|---|---|
| **Camp Management** | Rooms and beds, check in / check out, occupancy, company billing, man-days, location profit |
| **GES Manpower** | Staff list, transfers and resignations, vacation plan, monthly timesheet and salary |
| **Daily Costing & Stock** | Kitchen stock, daily consumption, monthly prices, man-days, budget per cost centre, alerts |
| **Duty Board** | Duty roster per department; department heads see only their department |
| **Dining Halls Management** | Dining hall gates: barcode and NFC cards, scanning on phones (camera, scanner or NFC), one meal per person, live counts, meal reports |

### Dining Halls Management

* **Every scan is decided by the server** (`POST /api/dining/scan`), so all gates share one list of who has
  eaten: a person refused at one gate is refused at every gate. A unique index in PostgreSQL refuses a
  second entry even when two gates scan the same card at the same moment.
* **No connection = no scanning.** The phone shows a red "No connection" banner and starts again by itself.
* Each scan is a row in `dining_scans` (kept forever, never part of the app document). Day and meal are
  worked out in camp time (Asia/Dubai). Rule: one entry per meal (default) or per day; meal times are set by an Admin.
* Roles: **Operator** = gate guard (scans only) · **Admin** = people, cards, companies, settings, "let in again",
  import · **Viewer** = records and reports.
* The old offline Mess Hall app's backup files (`mess_backup_*.json`) can be brought in from Settings; a record
  already brought in is skipped, so files from several phones can be merged safely.
* On a phone: open the portal in Chrome → Dining Halls → menu ⋮ → *Add to Home screen*.

Everyone works on the same data, from any browser (PC, tablet, phone). A change made by one person
appears on everyone else's screen within a second. The app screens are the same as in the desktop programs.

---

## Technologies

| Part | Technology |
|---|---|
| App screens | HTML5, CSS3, JavaScript (the original apps, unchanged), SheetJS + ExcelJS for Excel |
| Server | **Node.js 22**, built-in `http` module, one dependency: **`pg`** (PostgreSQL driver) |
| Database | **PostgreSQL 16** |
| Live updates | Server-Sent Events |
| Saving and merging | change "patches" shared by browser and server (`src/domain/patch.js`) |
| Passwords | scrypt with a random salt per password |
| HTTPS | Caddy (free certificate, renewed automatically) |
| Packaging | Docker + Docker Compose |
| Tests | Node.js test runner, against a real PostgreSQL database; GitHub Actions on every push |

## Accounts and roles

* **Portal admin** – manages users, backups, imports; is Admin in every app.
  The first one is created on the first start from `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
* Every other person gets a **role per app**: No access · Viewer · Operator · Admin.

| Role | Camp Management | Manpower / Costing |
|---|---|---|
| Viewer | sees everything except Location Profit; cannot change anything | sees everything; cannot change anything |
| Operator | check in/out, reservations, resident details, room sizes, bathrooms, housekeeping | can change data |
| Admin | everything: blocks, rooms, capacity, companies, camps, deleting log records, profit | everything (Costing: also "Clear day") |

The **server** enforces the roles. A blocked attempt is refused, explained to the user and written to the activity log.

---

## How data is protected (no data loss)

1. **Every change is written to PostgreSQL inside a transaction before the browser is told "saved".**
   If the database write fails, nothing changes and the browser keeps the change and retries.
2. **Every change is kept forever** in `app_changes`, with who made it and when.
   A full copy (`app_documents`) is written every 50 changes and at shutdown;
   at start-up the server loads that copy and replays the changes after it. The restart test proves the
   data comes back identical.
3. **Full copies** (`app_snapshots`) are kept at the start of each day (60 days), before every import, and
   whenever an admin clicks *Back up now*. Admins can download any of them.
4. **Nightly database dump** (`pg_dump`) of everything, written to `./backups` on the server (30 days).
5. **Several people at once**: each browser sends only what it changed; the server applies changes one at
   a time and merges them record by record. If two people change *the same field of the same record*
   at the same moment, the later one wins. If a change cannot be applied (e.g. the room was deleted
   meanwhile) the user is told and it is recorded in the activity log. Nothing is silently dropped.
6. **Only one server** may write to a database (a PostgreSQL lock); a second one refuses to start.
7. **Imports** (replacing an app's data) keep the old data as a backup first.
8. **Dining hall scans** are rows in `dining_scans`, each written before the gate is answered, and included in
   the nightly database dump.

### Text cleaning

To stop one user from planting code that runs in another user's browser, a few characters are swapped
for look-alikes when saved. **Nothing is deleted**:
* Camp Management: `<` `>` `"` `'` become `‹` `›` `”` `’` (the Camp screens put names inside page code).
* Manpower and Costing: `<` `>` become `‹` `›`.

Importing the real data from this company's desktop programs changed exactly one value: `Côte d'Ivoire`
became `Côte d’Ivoire` in the Camp nationality list.

---

## Put it online on Railway (recommended)

The Railway service settings are kept in `.railway/railway.ts` (Railway's Infrastructure as Code): Railway builds the
`Dockerfile`, checks `/healthz`, restarts on failure, and runs **one** copy of the server (the server is the single
writer of the database - do not add replicas). Railway does not read this file during deploys: after changing it, run
`railway config plan` (preview) and `railway config apply` from the project folder (needs `npm install` for the
`railway` dev package). Service variables are not managed by the file (they stay as set in Railway).

1. On [railway.com](https://railway.com): **New Project → Deploy from GitHub repo** → choose this repository
   (allow Railway's GitHub app to read it).
2. In the project: **+ New → Database → PostgreSQL**.
3. Open the portal service → **Variables** and add:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway fills in the private address of the database) |
   | `ADMIN_USERNAME` | `admin` |
   | `ADMIN_PASSWORD` | your admin password (kept only in Railway, never in the code) |
   | `ADMIN_MUST_CHANGE` | `false` |
   | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `30` (gives the old server time to save and hand over during a deploy) |

   `PORT` is set by Railway, and `TRUST_PROXY=1` is already set in the Dockerfile.
4. Portal service → **Settings → Networking → Generate Domain** (or add your own domain). HTTPS is automatic.
5. Railway deploys. The logs end with `[start] ready.` Open the domain and sign in as the admin.
6. Bring in the desktop data and create the accounts (steps 7–9 of the next section).

**Updating:** push to GitHub; Railway deploys automatically. The new server starts while the old one is still running,
answers "updating, please wait" for a few seconds, waits for the old one to stop, then takes over with the same data.
Saves made during the switch are retried by the browsers, not lost.

**Backups on Railway:**
* inside the database (always on): every change, daily copies (60 days), copies before imports - see *Users, backups & activity*;
* **turn on Railway's own backups** for the PostgreSQL service (PostgreSQL service → *Backups*, set a daily schedule);
* keep an **off-site copy**: download *Download current data* for each app weekly, or run `pg_dump` from your PC
  against the PostgreSQL service's public connection URL.

The `backup` service in `docker-compose.yml` is for a self-managed server (next section); Railway does not use it.

## Put it online on your own server (Docker Compose)

You need a Linux server (for example 2 vCPU / 2 GB RAM, Ubuntu 24.04) and a domain or sub-domain.

1. **DNS:** add an **A record** for your domain (e.g. `portal.yourcompany.com`) pointing to the server's IP address.
2. **Install Docker** on the server:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
3. **Get the code** onto the server:
   ```bash
   git clone https://github.com/<your-account>/<your-repo>.git /opt/ges-portal
   ```
4. **Settings:**
   ```bash
   cd /opt/ges-portal
   cp .env.example .env
   nano .env
   ```
   Set `DOMAIN`, a long random `POSTGRES_PASSWORD` (letters and numbers), and `ADMIN_PASSWORD`.
5. **Start:**
   ```bash
   docker compose up -d --build
   ```
6. Open `https://<your domain>` and sign in as the admin.
7. **Bring in the data** from the desktop programs: *Users, backups & activity → Backups & import*.
   Choose the app and its `app_data.json` from `%APPDATA%` on the desktop PC:

   | App | Folder in `%APPDATA%` |
   |---|---|
   | Camp Management | `global-village-camp-management` |
   | GES Manpower | `ges-manpower-system` |
   | Daily Costing & Stock | `ges-daily-costing-stock` |

8. **Create the accounts** on the Users page and give each person their temporary password privately.
9. In Manpower → Timesheet, load the company timesheet `.xlsx` once. It is stored on the server for everyone.

Only ports 80 and 443 need to be open.

### Updating

```bash
cd /opt/ges-portal
git pull
docker compose up -d --build
```
Database changes (migrations) are applied automatically at start-up.

---

## Operations

| Task | How |
|---|---|
| See the logs | `docker compose logs -f app` |
| Status of each app's data | `docker compose exec app node src/cli.js status` |
| Forgotten admin password | `docker compose exec app node src/cli.js reset-admin` (prints a temporary password) |
| Someone forgot their password | Users page → *Reset password* |
| Someone left | Users page → *Disable* (signs them out at once, keeps their name in the history) |
| Download a backup of one app | Users page → *Backups & import* → *Download* |
| Restore one app from a backup | download the backup, then *Import and replace* it (the current data is kept as a backup first) |
| Restore the whole database | see below |

### Restore the whole database from a nightly dump

```bash
docker compose stop app
docker compose exec backup sh -c 'pg_restore --clean --if-exists -d portal /backups/portal_YYYY-MM-DD_HHMM.dump'
docker compose start app
```

**Keep a copy of `./backups` somewhere else as well** (another server, cloud storage). A backup kept only on the
same server does not protect against losing that server.

---

## Development

Requirements: Node.js 22+, PostgreSQL 16.

```bash
npm install
```

```bash
cp tools/app-sources.example.json tools/app-sources.json
```

```bash
npm run build:apps
```

`build:apps` rebuilds `public/apps/*` from the desktop programs (paths in `tools/app-sources.json`). It moves
built-in personal data out of the pages into `seed/`, which is never committed, and removes written-in
passwords. Every edit must match exactly, or the build stops.

Run locally (any empty PostgreSQL database):

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/portal ADMIN_PASSWORD=choose-a-password npm start
```

Tests (the test database is **wiped**; its name must contain "test"):

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/portal_test npm test
```

### Project layout

```
src/
  server.js            start-up, single-server lock, housekeeping, clean shutdown
  app.js               request handling: sign-in checks, roles, app files, errors
  config.js            settings from environment variables
  container.js         creates repositories and services
  cli.js               reset-admin, import, status
  db/                  connection pool, migrations (SQL), single-server lock
  domain/              merge engine (patch.js), text cleaning, roles, per-app rules (apps/)
  repositories/        one class per table, parameterised SQL only
  services/            auth, passwords, user admin, documents (data safety), live updates
  http/                router, request/response helpers, static files, security headers
  routes/              pages, auth, apps (data/changes/files), admin
public/
  index.html login.html admin.html     portal pages
  shared/              portal bar + sync layers that connect each app to the server
  apps/                the three apps (built by tools/build-apps.js)
test/                  unit tests and integration tests (real PostgreSQL)
tools/                 build of the apps from the desktop programs
scripts/backup-loop.sh nightly pg_dump
```

### Settings

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | – (required) | PostgreSQL connection |
| `PORT` / `HOST` | 8080 / 0.0.0.0 | where the server listens |
| `TRUST_PROXY` | off | `1` behind Caddy/Nginx (HTTPS cookies, real client addresses) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | admin / random | first super user, only on the very first start |
| `ADMIN_MUST_CHANGE` | false if a password is given | force a new password at first sign-in |
| `SESSION_IDLE_HOURS` / `SESSION_MAX_DAYS` | 12 / 14 | sign-out after inactivity / at the latest |
| `SNAPSHOT_DAYS` | 60 | daily copies kept in the database |
| `CHECKPOINT_EVERY` | 50 | changes between full copies |
| `MAX_UPLOAD_MB` | 80 | largest import / save |
| `DATABASE_POOL_SIZE` | 10 | database connections |
| `LOCK_WAIT_SECONDS` | 600 | how long a new server waits for the previous one to stop during a deploy |
