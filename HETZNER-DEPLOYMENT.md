# Hetzner deployment (a plan - not built)

Hosting **the customers' helpdesks** on Hetzner Cloud instead of one Azure
web app and plan per customer. The customer portal can stay on Azure (one
small app) or move too; section 9 covers it.

Nothing here exists yet. It is the design to pick up once the Azure version
works end to end, with the choices explained so they can be changed.

---

## 1. Why, in numbers

Rough monthly prices; check Hetzner's and Azure's current price lists
before deciding.

| | Azure (as built) | Hetzner (this plan) |
| --- | --- | --- |
| Per customer | one App Service plan B1 (~12 EUR) + a database on the shared PostgreSQL | a container on a shared server: cents |
| 20 small customers | ~240 EUR + PostgreSQL + Key Vault | one CPX31-class server (~15-20 EUR) + a volume + object storage for backups (~10 EUR) |
| What you get extra | managed platform: patching, scaling, managed identities, Key Vault | full control, EU data centres (Germany, Finland), predictable flat prices |
| What you do yourself | little | OS updates, Docker, TLS, backups, monitoring - automated below |

The helpdesk suits this well:

- **It already runs in Docker** (`Dockerfile`, `compose.yaml`, `deploy/Caddyfile`, DEPLOYMENT.md section 2).
- **SQLite is the right database here.** On a server's own disk (or a
  Hetzner Volume, which is a block device attached to one server) SQLite
  is safe and fast - the Azure problem (network file storage under
  `/home`) does not exist. The move to PostgreSQL stops being urgent.
- One process per customer, small memory footprint: many customers fit on
  one server.

## 2. The shape

```
 GitHub                                   Hetzner Cloud (fsn1 / nbg1 / hel1)
 ┌───────────────────────────┐           ┌──────────────────────────────────────────────┐
 │ helpdesk repo             │  image    │ server "helpdesk-1" (Ubuntu, Docker)         │
 │  build -> GHCR            │──────────>│  Caddy  :443  *.helpdesk.example.com          │
 │  ghcr.io/.../helpdesk:     │           │   ├ contoso.helpdesk.example.com -> :3001    │
 │   stable/previous/dev     │           │   ├ fabrikam.helpdesk.example.com -> :3002   │
 │ infra repo                │  ssh      │   └ ...                                      │
 │  terraform/  customers.yml│──────────>│  one container per customer                  │
 │  deploy workflow          │           │  Volume /mnt/data/<customer>/ (SQLite, files)│
 └───────────────────────────┘           │  Litestream -> Object Storage (backups)      │
              ^                          └──────────────────────────────────────────────┘
              │ commit to customers.yml   DNS: *.helpdesk.example.com -> server IP
 customer portal (order placed)
```

- **One server hosts many customers**, each a container with its own data
  directory, port and subdomain. A second server is added when the first
  is full; `customers.yml` says which customer lives where.
- **Caddy** terminates TLS (automatic Let's Encrypt certificates) and
  routes each subdomain to its container.
- **Images** are built once by GitHub Actions and pushed to the **GitHub
  Container Registry** (free for private images within your plan's
  storage). The channels become image tags: `:stable`, `:previous`,
  `:development` - the same meaning as today's git refs.
- **Data** lives on a Hetzner **Volume** mounted at `/mnt/data`, so the
  server can be rebuilt without touching it. **Litestream** streams every
  SQLite change to Hetzner **Object Storage** (S3-compatible) - restore to
  any point, on any server.

(Alternative: **one small server per customer**, ~4-5 EUR each. Simpler
isolation, still far cheaper than Azure B1, more servers to patch. The
same pieces apply with one customer per host.)

## 3. How this is usually done: the three layers

| Layer | Tool | Changes when |
| --- | --- | --- |
| **Infrastructure** - servers, volumes, firewall, DNS, object storage | **Terraform** (`hcloud` provider), state kept remotely | rarely: a new server, a bigger volume |
| **Image** - the application, built and tested once | **GitHub Actions** -> GHCR | every push / promotion |
| **Deployment** - which customer runs which image where | **GitHub Actions** + SSH + `docker compose`, driven by a file in git (`customers.yml`) | every new customer, every release |

Keeping "which customers exist" in a git file is called **GitOps**: the
repository is the truth, every change is a reviewed commit, and a rollback
is a revert. The portal adds a customer by committing to that file through
the GitHub API, instead of calling Azure.

## 4. Infrastructure with Terraform

A private `helpdesk-infra` repository:

```
terraform/
  main.tf            servers, volume, firewall, DNS
  cloud-init.yaml    first boot: Docker, the volume, the deploy user
customers.yml        who lives where
deploy/
  compose.tmpl.yaml  one service per customer
  Caddyfile.tmpl
.github/workflows/
  infra.yml          terraform plan on PRs, apply on main
  deploy.yml         render + push + docker compose up
```

`terraform/main.tf` (sketch):

```hcl
terraform {
  required_providers {
    hcloud = { source = "hetznercloud/hcloud" }
  }
  # Remote state, so CI and you share it. Hetzner Object Storage is S3-compatible.
  backend "s3" {
    bucket                      = "helpdesk-tfstate"
    key                         = "prod/terraform.tfstate"
    region                      = "eu-central"
    endpoints                   = { s3 = "https://fsn1.your-objectstorage.com" }
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    use_path_style              = true
  }
}

variable "hcloud_token" { sensitive = true }
provider "hcloud" { token = var.hcloud_token }

resource "hcloud_ssh_key" "deploy" {
  name       = "github-deploy"
  public_key = file("${path.module}/deploy_key.pub")
}

resource "hcloud_firewall" "web" {
  name = "helpdesk-web"
  rule { direction = "in", protocol = "tcp", port = "443", source_ips = ["0.0.0.0/0", "::/0"] }
  rule { direction = "in", protocol = "tcp", port = "80",  source_ips = ["0.0.0.0/0", "::/0"] }
  # SSH only from where you administer it; GitHub's runners use a jump host
  # or Tailscale in practice - see section 6.
  rule { direction = "in", protocol = "tcp", port = "22",  source_ips = ["<your office IP>/32"] }
}

resource "hcloud_server" "helpdesk_1" {
  name         = "helpdesk-1"
  server_type  = "cpx31"
  image        = "ubuntu-24.04"
  location     = "fsn1"
  ssh_keys     = [hcloud_ssh_key.deploy.id]
  firewall_ids = [hcloud_firewall.web.id]
  user_data    = file("${path.module}/cloud-init.yaml")
  backups      = true # Hetzner's daily server backups, +20 % of the server price
}

resource "hcloud_volume" "data_1" {
  name      = "helpdesk-1-data"
  size      = 50
  server_id = hcloud_server.helpdesk_1.id
  automount = true
  format    = "ext4"
}

output "helpdesk_1_ip" { value = hcloud_server.helpdesk_1.ipv4_address }
```

DNS: one wildcard record `*.helpdesk.example.com` pointing at the server
(Hetzner DNS has a Terraform provider; Cloudflare does too). With a
wildcard, a new customer needs **no** DNS change.

`terraform/cloud-init.yaml` (sketch): install Docker from Docker's
repository, create a `deploy` user in the `docker` group with the deploy
key, `unattended-upgrades` for security updates, and a systemd unit for
Litestream.

## 5. The application side

### Image (in the helpdesk repository)

`.github/workflows/image.yml`:

- on push to `development`: build, test, push `ghcr.io/<owner>/servideskly:development` and `:sha-<commit>`;
- "Promote a release" (exists) additionally retags: the old `:stable` becomes `:previous`, the promoted commit becomes `:stable`.

Built with `docker/build-push-action`, logging in to GHCR with the
workflow's own `GITHUB_TOKEN` (`packages: write`) - no extra secret.

### One customer = one compose service

`customers.yml`:

```yaml
- name: contoso            # subdomain and data directory
  host: helpdesk-1
  channel: stable          # stable | previous | development
  port: 3001
  admin_email: it@contoso.com
- name: fabrikam
  host: helpdesk-1
  channel: previous
  port: 3002
  admin_email: ops@fabrikam.com
```

Rendered into `compose.yaml` on the host:

```yaml
services:
  contoso:
    image: ghcr.io/<owner>/servideskly:stable
    restart: unless-stopped
    env_file: /mnt/data/contoso/.env       # its secrets, never in git
    environment:
      APP_BASE_URL: https://contoso.helpdesk.example.com
      HOST: 0.0.0.0
      PORT: "3000"
      TRUST_PROXY: "1"
      DATABASE_PATH: /data/ticketing.sqlite
      UPLOAD_DIR: /data/uploads
    volumes:
      - /mnt/data/contoso:/data
    ports:
      - "127.0.0.1:3001:3000"              # only Caddy reaches it
    mem_limit: 512m
```

and the Caddyfile:

```
contoso.helpdesk.example.com {
    reverse_proxy 127.0.0.1:3001
}
```

## 6. CI/CD: deploying

`deploy.yml` in the infra repository, on every push to `customers.yml`
(and by hand):

1. For each host: render `compose.yaml` and the `Caddyfile` from
   `customers.yml` and the templates.
2. For a customer seen for the first time: create `/mnt/data/<name>/`
   and its `.env` (a generated `SESSION_SECRET`; the first administrator).
3. Copy both files to the host, then
   `docker compose pull && docker compose up -d --remove-orphans` and
   `caddy reload`. Unchanged containers are left running.

**Reaching the server from GitHub's runners.** Their IP addresses change,
so opening SSH to them is not practical. Usual answers, in order of
preference:

- **Tailscale** (free for small use): the runner joins your tailnet for the
  job (`tailscale/github-action`), the server's SSH listens only on the
  tailnet, port 22 stays closed to the internet;
- a **self-hosted runner** on a small management server;
- **pull instead of push**: a timer on each server pulls the infra repo
  and applies it - no inbound access at all, at the cost of a delay.

**A release reaching customers:** "Promote a release" retags the image;
customers on `stable` pick it up on the next deploy run (run it after a
promotion - or have promotion trigger it). **Rollback** of one customer:
set `channel: previous` in `customers.yml` and commit.

## 7. Secrets

There is no Key Vault on Hetzner. Options:

| Secret | Where |
| --- | --- |
| Hetzner API token, SSH deploy key, object storage keys | GitHub Actions **secrets** of the infra repository |
| Each customer's `SESSION_SECRET` etc. | generated on first deploy into `/mnt/data/<name>/.env` (mode 600), never in git; backed up with the data |
| Shared application secrets (mail credentials...) | **SOPS + age**: encrypted files in git, decrypted in CI - or keep using Azure Key Vault from CI |

## 8. Backups, monitoring, updates

- **Litestream** per customer database -> Object Storage: continuous,
  point-in-time restore. Test a restore before the first customer.
- **Hetzner server backups** (daily, 7 kept) for the rest; **volume
  snapshots** before risky changes.
- **Uploads** (`/mnt/data/<name>/uploads`): restic or rclone to Object
  Storage nightly.
- **Monitoring**: an uptime check per customer on its `/readyz`
  (e.g. Uptime Kuma on the management box, or a hosted monitor); disk and
  memory alerts from Hetzner's console or node-exporter.
- **Updates**: `unattended-upgrades` for the OS; Docker images rebuilt on
  every release; Caddy renews certificates itself.

## 9. The customer portal

Today the portal's worker calls Azure (resource group, plan, web app,
Key Vault access) and dispatches "Deploy to a customer". For Hetzner its
steps become:

1. create the customer's database? - **not needed** (SQLite per container);
2. **commit** the new entry to `customers.yml` through the GitHub API
   (the same fine-grained token idea, scoped to the infra repository);
3. wait for the deploy workflow; mark the order ready at
   `https://<name>.helpdesk.example.com`.

Fewer steps and fewer permissions than Azure. The portal itself can run as
one more container on the same server (its own subdomain), or stay on
Azure - it needs no Azure features beyond Entra External ID, which works
from anywhere.

## 10. Things to know about Hetzner

- **Outbound port 25 is blocked** on new accounts (anti-spam). The
  helpdesk's mail to Microsoft Graph and SMTP on 465/587 work; an SMTP
  relay on port 25 needs Hetzner to unblock it on request.
- **No managed database or secrets service** - SQLite + Litestream and
  section 7 cover it.
- **IPv4 addresses cost extra**; IPv6 is free. Keep IPv4 for the web
  server (most clients still need it).
- **Volumes attach to one server** at a time - fine for SQLite, and the
  reason a customer moves between servers by restoring from Litestream.
- Data centres: Falkenstein, Nuremberg (Germany), Helsinki (Finland) - EU
  for GDPR; Ashburn/Hillsboro/Singapore exist if ever needed.

## 11. Order of work, when the time comes

1. Hetzner account, an API token, a project; Object Storage bucket for
   Terraform state and backups.
2. `helpdesk-infra` repository with the Terraform above; `terraform apply`
   creates the first server and volume; wildcard DNS.
3. Image workflow in the helpdesk repository (GHCR, the three tags).
4. `customers.yml` + deploy workflow; one test customer by hand.
5. Litestream and a tested restore.
6. Portal: a Hetzner provisioning path (commit to `customers.yml`).
7. Move existing Azure customers (export SQLite / restore), then retire
   their Azure resource groups.
