# Running ServiDeskly on Azure

One helpdesk on Azure App Service with Azure Database for PostgreSQL and
Key Vault, from an empty subscription. Every secret stays in Key Vault; the
web app reads it with its own managed identity.

For a single server with Docker instead, see [DEPLOYMENT.md](DEPLOYMENT.md).

Work in the Azure portal's **Cloud Shell** (bash) and run `az account show`
before anything: the wrong subscription is the most expensive mistake here.

| Placeholder | Example |
| --- | --- |
| `<rg>` | `rg-helpdesk` |
| `<location>` | `westeurope` - put everything in one region |
| `<pg>` | `helpdesk-pg` (globally unique) |
| `<kv>` | `kv-helpdesk` (globally unique, 3-24 characters) |
| `<app>` | `helpdesk-acme` (globally unique: `<app>.azurewebsites.net`) |

## 1. Resource providers and a resource group

```bash
for ns in Microsoft.DBforPostgreSQL Microsoft.Web Microsoft.KeyVault; do az provider register --namespace $ns --wait; done
```

```bash
az group create --name <rg> --location <location>
```

## 2. PostgreSQL

```bash
az postgres flexible-server create --resource-group <rg> --name <pg> --location <location> --tier Burstable --sku-name Standard_B1ms --storage-size 32 --version 16 --admin-user pgadmin --admin-password "<strong password>" --public-access 0.0.0.0
```

`--public-access 0.0.0.0` allows Azure services, not the internet. For
anything beyond a trial, use private networking (a VNet with a private
endpoint) and set the backup retention you need:
`az postgres flexible-server update -g <rg> -n <pg> --backup-retention 14`.

A database and login for the helpdesk - from Cloud Shell,
`psql "host=<pg>.postgres.database.azure.com user=pgadmin dbname=postgres sslmode=require"`:

```sql
CREATE ROLE helpdesk LOGIN PASSWORD '<another strong password>';
CREATE DATABASE helpdesk OWNER helpdesk;
\c helpdesk
GRANT ALL ON SCHEMA public TO helpdesk;
ALTER SCHEMA public OWNER TO helpdesk;
```

(PostgreSQL 15 and later refuse table creation in `public` without the last
two lines.)

## 3. Key Vault - and keeping its secrets

```bash
az keyvault create --resource-group <rg> --name <kv> --location <location> --enable-rbac-authorization true --retention-days 90 --enable-purge-protection true
```

```bash
az role assignment create --assignee "$(az ad signed-in-user show --query id -o tsv)" --role "Key Vault Secrets Officer" --scope "$(az keyvault show -n <kv> --query id -o tsv)"
```

Two secrets (URL-encode special characters in the password: `@` is `%40`,
`:` is `%3A`, `/` is `%2F`, `#` is `%23`):

```bash
az keyvault secret set --vault-name <kv> --name helpdesk-database-url --value "postgres://helpdesk:<password>@<pg>.postgres.database.azure.com:5432/helpdesk?sslmode=verify-full"
```

```bash
az keyvault secret set --vault-name <kv> --name helpdesk-session-secret --value "$(openssl rand -base64 48 | tr -d '\n')"
```

**Back up the session secret somewhere other than this vault.** People's
details, the audit trail, queued mail and every attachment are encrypted at
rest with a key derived from it (DEPLOYMENT.md, "The encryption key").
Losing it loses that data; changing it does too. Purge protection keeps a
deleted secret recoverable for 90 days.

## 4. The web app

Linux, Node 24. **B1** or above (F1 sleeps when idle and has a daily CPU
quota).

```bash
az appservice plan create --resource-group <rg> --name <app>-plan --is-linux --sku B1
```

```bash
az webapp create --resource-group <rg> --plan <app>-plan --name <app> --runtime "NODE:24-lts"
```

```bash
az webapp config set --resource-group <rg> --name <app> --startup-file "node dist/server.js" --always-on true --min-tls-version 1.2 --ftps-state Disabled
```

```bash
az webapp update --resource-group <rg> --name <app> --https-only true
```

Its identity, allowed to read **only its two secrets**:

```bash
az webapp identity assign --resource-group <rg> --name <app>
```

```bash
for s in helpdesk-database-url helpdesk-session-secret; do az role assignment create --assignee "$(az webapp identity show -g <rg> -n <app> --query principalId -o tsv)" --role "Key Vault Secrets User" --scope "$(az keyvault show -n <kv> --query id -o tsv)/secrets/$s"; done
```

## 5. App settings

After the role assignments (App Service caches a failed Key Vault lookup).
The secrets are **Key Vault references**, so no setting holds a secret:

```bash
az webapp config appsettings set -g <rg> -n <app> --settings NODE_ENV=production APP_BASE_URL=https://<app>.azurewebsites.net HOST=0.0.0.0 TRUST_PROXY=1 UPLOAD_DIR=/home/data/uploads SCM_DO_BUILD_DURING_DEPLOYMENT=false "SESSION_SECRET=@Microsoft.KeyVault(VaultName=<kv>;SecretName=helpdesk-session-secret)" "DATABASE_URL=@Microsoft.KeyVault(VaultName=<kv>;SecretName=helpdesk-database-url)"
```

Check: Azure portal - the web app - **Environment variables**: both Key
Vault settings show a green tick. A red cross is almost always the role
assignment or a secret name; set the setting again once it is fixed.

If you run a **modified** copy, also set `SOURCE_URL` to your own repository:
the AGPL-3.0 requires offering your users the source of what they use, and
every page links to it.

## 6. Deploy

The package must be built on **Linux x64 with Node 24**: `better-sqlite3` is
a native module. From a Linux machine, WSL, or a GitHub Actions runner:

```bash
npm ci && npm run build && npm ci --omit=dev && zip -qr helpdesk.zip dist node_modules views public package.json src/i18n/strings.json
```

```bash
az webapp deploy --resource-group <rg> --name <app> --src-path helpdesk.zip --type zip --clean true
```

Or from GitHub: fork this repository, and the **Deploy to a customer**
workflow (`.github/workflows/deploy-customer.yml`) deploys a branch to a web
app with OpenID Connect - it needs an app registration with a federated
credential for your repository and the variables `AZURE_CLIENT_ID`,
`AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`.

Check: `https://<app>.azurewebsites.net/readyz` answers 200.

## 7. The first administrator

A production helpdesk has **no password account to start from**. Its first
administrator comes from a one-time link signed with its own session secret.
In the Azure portal - the web app - **SSH**:

```bash
cd /home/site/wwwroot && node dist/auth/setup-link-cli.js you@example.com
```

Open the printed link within the hour and choose a password. It works once.
Then set up sign-in for everybody else under **Settings - Integrations**
(Microsoft Entra ID, Google, Okta or any OpenID Connect provider) and your
mailbox under **Settings - Mail**.

## 8. Your own domain

Web app - **Custom domains** - **Add custom domain** with an *App Service
Managed Certificate*; add the records it shows at your DNS provider. Then
set `APP_BASE_URL` to `https://<your domain>`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `MissingSubscriptionRegistration` | step 1 |
| A Key Vault setting shows a red cross | the role assignment in step 4; then set the setting again |
| "permission denied for schema public" | the GRANT and OWNER lines in step 2 |
| The app starts and stops at once | the log stream (web app - Log stream); usually an unresolved Key Vault reference, which the helpdesk refuses to start with |
| Details show as empty or `enc:v1:...` | the session secret changed: restore the previous version in Key Vault |
