# Running and deploying the helpdesk

Three situations, in the order you are likely to meet them:

1. [Running it locally](#1-running-it-locally) - the proof of concept. Nothing to install.
2. [Running it in Docker](#2-running-it-in-docker) - a single host, TLS, backups.
3. [Azure Web App, and the move to SQL Server](#3-azure-web-app-and-the-move-to-sql-server) - what has to change, and what will bite.

---

## 1. Running it locally

**Nothing has to be installed but Node.js 22+.** The database is SQLite - a
single file under `data/` - so there is no server to set up.

```bash
npm install
cp .env.example .env
```

For a local run you need four lines in `.env`:

```ini
NODE_ENV=development
APP_BASE_URL=http://localhost:3000
LOCAL_SEED_PASSWORD=1234
PASSWORD_MIN_LENGTH=4
```

```bash
npm run dev
```

Open `http://localhost:3000/login`. Two accounts are created on the first
start:

| Username | Password | Role                   | What it is for                          |
| -------- | -------- | ---------------------- | --------------------------------------- |
| `admin`  | `1234`   | Administrator          | Triage, settings, templates, accounts   |
| `user`   | `1234`   | User                   | Raising tickets, seeing only their own  |

Both passwords are changeable under **Profile → Password**, and an
administrator can reset either (and create more accounts) under
**Admin → Accounts**.

`LOCAL_SEED_PASSWORD` and `PASSWORD_MIN_LENGTH` are ignored when
`NODE_ENV=production`: there, `admin` gets a random password written to the log
once, no second account is created, and the minimum length is forced back to
12. A short password cannot leak out of the proof of concept by accident.

**Single sign-on is not needed for any of this.** The application starts with
no identity provider configured at all - a supported state - and the local
accounts work regardless. Entra ID can be added later from
**Admin → Settings → Authentication** without touching a config file.

### Starting over

The entire state is two paths. Delete them and the next start rebuilds
everything from scratch:

```bash
rm -rf data/ticketing.sqlite* data/uploads
```

### What works without any further setup

- Raising, triaging, assigning, commenting and closing tickets
- Internal notes, hidden from the requester
- Attachments, added while raising a ticket or afterwards, with the type
  verified from the file's own bytes
- Ticket templates, created under **Admin → Templates**
- Light and dark mode, chosen per reader from the footer
- Local accounts, created under **Admin → Accounts**
- The audit trail, under **Admin → Audit**
- Branding - logo, favicon, colours - under **Admin → Settings → Customization**

Not built, because you said they are not wanted yet: email or Azure
Communication Services notifications, and Entra ID sign-in (the code is
there and configurable, it is simply not required).

---

## 2. Running it in Docker

```bash
cp deploy/env.example .env
chmod 600 .env          # fill in HELPDESK_DOMAIN, ACME_EMAIL, SESSION_SECRET
docker compose up -d --build
docker compose logs app | grep -A6 'local administrator'   # the one-time password
```

Two services: the application, and Caddy in front of it obtaining its own TLS
certificate. There is no database service - SQLite is a file in the `data`
volume, next to the attachments.

```
   internet ──► proxy (Caddy) ──[edge]──► app ──► /data volume
```

The application container runs as uid 1000, drops all Linux capabilities, gets
`no-new-privileges`, and has a read-only root filesystem. The only writable
paths are `/tmp` (a tmpfs) and `/data`.

### The limit worth knowing before you rely on it

**One application container.** SQLite is a file, not a server, so a second
container cannot share it - `docker compose up --scale app=2` will corrupt
data, not balance load. The same rule rules out any host where the volume is a
network share. If you need more than one instance, that is the point at which
the database has to move (§3).

### Backups

One volume holds everything - database, attachments, uploaded branding:

```bash
docker run --rm -v helpdesk_data:/data:ro -v /var/backups:/backup \
  busybox tar czf /backup/helpdesk-$(date +%F).tar.gz -C /data .
```

Take it with the container **stopped**, or use SQLite's own backup, which is
safe against a running writer:

```bash
docker compose exec app node -e "
  const Database = require('better-sqlite3');
  new Database('/data/ticketing.sqlite', { readonly: true })
    .backup('/data/backup.sqlite')
    .then(() => console.log('done'));
"
```

Restoring is the reverse: stop the container, replace the volume contents,
start it. Restore with the **same `SESSION_SECRET`** the backup was taken
under, or the stored identity-provider secrets cannot be decrypted and have to
be re-entered.

### The encryption key - back it up, or lose the data

People's details (department, job title, office, phone, extension
attributes), the audit trail's who, where and detail, queued mail, and every
attachment file are **encrypted at rest** with a key derived from the
**last entry of `SESSION_SECRET`** (`src/lib/field-crypto.ts`). The database
and the uploads folder alone cannot be read - which is the point - and so:

- **Back `SESSION_SECRET` up somewhere other than the database it protects.**
  On Azure it is the helpdesk's own Key Vault secret; keep soft delete and
  purge protection on that vault.
- **Never change or drop its last entry.** A new secret is added at the
  front of the list; the last one is the key. Losing it loses the encrypted
  data, with no recovery, by design.
- A backup is only useful together with that secret.

Data from before encryption is encrypted in the background at start-up and
hourly (`src/services/data-sealing.ts`); reading works either way meanwhile.

### Upgrades

```bash
docker compose down
docker run --rm -v helpdesk_data:/data:ro -v /var/backups:/backup \
  busybox tar czf /backup/pre-upgrade.tar.gz -C /data .
git pull && docker compose up -d --build
```

Schema migrations are forward-only and run automatically at start-up, each in
its own transaction.

---

## 3. Azure Web App, and the move to SQL Server

> The step-by-step Azure setup (resources, identities, Key Vault, GitHub
> Actions, the customer portal) is [AZURE-DEPLOYMENT.md](AZURE-DEPLOYMENT.md).

This is where you said you are heading: an Azure Web App, secrets in Key
Vault, and a SQL Server VM. Three separate pieces of work, in increasing
order of size.

### 3.1 Configuration and secrets

Nothing to build. The application reads its configuration from environment
variables, which is exactly what App Service **Application settings** are, and
what a Key Vault reference resolves into:

```
@Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/helpdesk-session-secret/)
```

Set at minimum `NODE_ENV=production`, `APP_BASE_URL=https://<your-app>`,
`TRUST_PROXY=1` (App Service terminates TLS in front of you) and
`SESSION_SECRET`. Turn on the Web App's system-assigned managed identity and
give it **Key Vault Secrets User** on the vault.

`SESSION_SECRET` accepts a comma-separated list, newest first, so it can be
rotated without signing everybody out - **but keep the last entry stable**,
because the stored Entra client secret, and everything encrypted at rest
(section 2, "The encryption key"), is encrypted with a key derived from it.

### 3.2 The storage problem - read this before deploying as-is

**SQLite on App Service will lose or corrupt data.** Not "might":

- `/home` is an Azure Files share. It is a network filesystem, and SQLite's
  locking does not work reliably over one. Concurrent writes can corrupt the
  database file.
- Anything *outside* `/home` is the container's own disk, which is **wiped on
  every restart, scale operation and deployment**. Tickets would vanish on the
  next platform-initiated restart, which you do not control.
- Any scale-out - even "Always On" plus an autoscale rule you forgot about - puts two instances on the same file.

So: deploy to App Service for a demo if you like, with
`WEBSITES_ENABLE_APP_SERVICE_STORAGE=false` and the understanding that the
data is disposable. For anything a real person files a ticket in, do §3.3
first. The same applies to attachments, which are files on the same disk - they will need Azure Blob Storage, or an Azure Files mount that is *only* used
for attachments (where the network filesystem is fine, because they are
written once and never locked).

### 3.3 Moving to SQL Server

The data layer was written to make this a contained change rather than a
rewrite. Everything above it already awaits, and nothing outside `src/db/`
knows what database is underneath.

What actually has to be done:

| Step | Where | Notes |
| --- | --- | --- |
| Swap the driver | `src/db/index.ts` | Replace `better-sqlite3` with `mssql`, keeping the exported shape: `query`, `queryOne`, `execute`, `count`, `transaction`, `clientOne`, `runMigrations`, `assertDatabaseReachable`, `pruneExpired`, `closeDatabase`. |
| Placeholders | `src/db/index.ts` | SQL Server uses named parameters (`@p1`). Translate positional `?` to those in the driver, so the ~85 call sites do not change. |
| Types | `src/db/migrations.ts` | `TEXT` → `nvarchar(max)`/`nvarchar(n)`, `INTEGER` 0/1 → `bit`, timestamps → `datetime2`. Keep the `BOOLEAN_COLUMNS` and `JSON_COLUMNS` conventions; `bit` comes back as a boolean, so the boolean mapping can then go. |
| The ticket counter | `src/services/tickets.ts` | `SELECT coalesce(max(seq),0)+1` is safe under SQLite's single writer, not under SQL Server. Use a `SEQUENCE` or an `IDENTITY` column. |
| Upserts | several | `ON CONFLICT ... DO UPDATE` becomes `MERGE`, or a `UPDATE`-then-`INSERT` inside the existing transaction. |
| `RETURNING *` | `users.ts`, `attachments.ts`, `flow-state.ts` | Becomes `OUTPUT INSERTED.*`. |
| `json_extract` | the sessions index | Becomes `JSON_VALUE(data, '$.userId')`, which SQL Server can index via a computed column. |
| Migration locking | `src/db/index.ts` | `sp_getapplock`, so two instances starting at once cannot race. |

Connection details go in the same environment variables, from Key Vault. Use
the managed identity rather than a SQL login if the VM is domain-joined to
Entra; otherwise a Key Vault secret.

Once that is done the one-container limit in §2 goes away, with one caveat
that is already in the code: runtime settings are cached per process and
refreshed when *that* process writes them, so a change made in
**Admin → Settings** on one instance is not seen by the others until they
restart. Fixing that needs a short poll or a change notification - worth doing
at the same time, since multiple instances is the reason you moved.

---

## 4. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| *Invalid environment configuration: APP_BASE_URL: Required* | No `.env`. `cp .env.example .env`. |
| Sign-in redirects back to `/login` with no error | `APP_BASE_URL` does not match the URL in the address bar, so the cookie is not returned. They must be identical, scheme included. |
| *This request appears to come from another site* | Same cause: reaching the app by a hostname other than `APP_BASE_URL`. |
| Every sign-in fails with a stale-form 403 behind a proxy | `APP_BASE_URL` is `https://` but `TRUST_PROXY` is unset, so the Secure cookie is never sent. Set `TRUST_PROXY=1`. |
| `SQLITE_BUSY` under load | Two processes on one file - `npm run dev` and a container, or a scaled-out deployment. There can be only one. |
| Attachments upload but 404 on download | `UPLOAD_DIR` moved, or the volume was recreated. The rows survive in the database; the bytes do not. |
| Forgotten `admin` password | Stop the service, delete the `local_credentials` row for it, restart: it is recreated with a fresh password in the log. `sqlite3 data/ticketing.sqlite "DELETE FROM local_credentials WHERE username='admin';"` |
| Uploads fail at a few megabytes behind the proxy | Caddy's `request_body max_size` in `deploy/Caddyfile` is below the application's limit. Raise it and restart the proxy. |

---

## 5. Before anyone else uses it

- [ ] `NODE_ENV=production`, and `LOCAL_SEED_PASSWORD` removed or ignored.
- [ ] The `admin` password changed from the generated one, and `1234` gone.
- [ ] `SESSION_SECRET` generated randomly and stored where you can retrieve it.
- [ ] `APP_BASE_URL` is `https://`, and TLS actually works.
- [ ] A backup taken **and a restore tested**.
- [ ] If this is more than a demo: §3.3 done, or a hard commitment to exactly
      one instance on local disk.
