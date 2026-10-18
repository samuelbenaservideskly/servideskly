# Encrypting what is in the database

Asked for by the owner on 16 Oct 2026:

> is it possible to somehow save the data to the database hashed and only to
> be decrypted by the application? Including attachments and all the user
> data that can fall under GDPR

and, a minute later, the sentence that decides the key management:

> and the data should only be decryptable by a single servicedesk instance

**Stages 1 and 2 built (18 Oct 2026), stage 3 left out on the owner's word.**
What is encrypted at rest now (`src/lib/field-crypto.ts`, key derived from the
last `SESSION_SECRET` entry under its own label):

- **Attachment files** (header `HDENC1`), read through `readAttachment()`;
  the export writes them decrypted, with a warning on its page.
- **`mail_outbox`**: `to_address`, `subject`, `body_html`.
- **`audit_log`**: `actor_email`, `ip`, `user_agent`, `detail` (the action,
  outcome and target stay readable; the trail is filtered by action).
- **`users`**: `department`, `job_title`, `office`, `phone`,
  `extension_attribute_1..3` (`SEALED_USER_COLUMNS`).

Reading is transparent: `fromDriver` in `db/index.ts` opens any value with
the `enc:v1:` prefix, by prefix rather than column, so aliases work. Writing
is per site (`sealText()`), and `src/services/data-sealing.ts` seals anything
still plain at start-up and hourly - that is also how data from before was
converted. **Not yet**: `company`, the names and the email (Reports group by
company, lists sort and search by name, sign-in and SCIM find by email - each
needs the work this document describes), and `ticket_comments.body` (stage 3,
with the ticket text: the owner chose to leave it). Tests:
`tests/encryption-at-rest.test.ts`; the queue cannot be searched in SQL any
more, so tests read it through `tests/support/outbox.ts`.

The rest of this document is the design as written before any of it was
built.

---

## First, the word

**Hashing is one way.** A hash of "Jan Novak" cannot be turned back into
"Jan Novak", which is right for a password and useless for a name the
service desk has to print on a ticket. What is wanted is **encryption**:
written with a key, read back with the same key.

So: encrypted at rest, decrypted by the application, with a key that only
this installation holds.

## What it protects, and what it does not

Worth being plain, because this is where encryption projects go wrong.

| | Protected? |
| --- | --- |
| A stolen disk, a stolen backup, a copied `.sqlite` file | **Yes** |
| A database administrator, or anybody with the connection string | **Yes** |
| Another helpdesk instance on the same shared PostgreSQL server | **Yes**, with a key per instance |
| Somebody who takes the application server **and** the database | No - the key is on the application server |
| Somebody signed in as an administrator | No - they are allowed to read it |

The first three are what an auditor asks about and what the owner's sentence
describes. The last two are answered by other things in this codebase (the
session rules, the roles, the audit trail), not by this.

## The key

One key per installation, never in the database:

- **Azure**: a Key Vault secret, read at start-up, like the PostgreSQL URL
  and the SCIM token already are.
- **Elsewhere**: an environment variable, or derived from `SESSION_SECRET`
  with a label - exactly how the admin-setup token's key is derived today
  (`helpdesk-admin-setup-v1`), so the pattern is already in the codebase.

That derivation is what makes "only one service desk can read it" literally
true: two instances on one database server have different secrets, so one
cannot read the other's rows.

**The thing to decide before any code**: losing the key loses the data.
There is no recovery, by design. The deployment has to back the key up
somewhere other than the database it protects, and `DEPLOYMENT.md` needs a
paragraph saying so.

## The primitive already exists

`src/lib/secret-box.ts` seals a mailbox password, a connection secret, an
OAuth refresh token and an SMTP relay password today. It is
authenticated encryption with a versioned prefix, so a sealed value says
which key sealed it - which is what makes a key change a migration rather
than a disaster.

Encrypting more columns is that function applied more widely, plus the three
problems below.

---

## Stage 1: the cheap and complete half

Nothing in this stage is searched, sorted or matched, so encrypting it costs
nothing but the bytes.

- **Attachment files.** The biggest single win: a stolen uploads folder is
  everything anybody has ever sent the service desk. Encrypt each file with
  a per-file key sealed in its `attachments` row.
- **`mail_outbox.body_html`** - queued mail, which is ticket text.
- **`audit_log.detail`** - carries names, addresses and reasons.
- **`ticket_comments.body`** - the conversation. Searched only through the
  ticket search (see stage 3), so it is worth checking whether anybody uses
  it before deciding which stage this belongs in.

This stage alone answers "the attachments and the words" and could ship on
its own.

## Stage 2: the person

`users` is what "all the user data that can fall under GDPR" means. Each
column has a different answer, and the table is why this is not one commit:

| Column | Used for | Can it be encrypted? |
| --- | --- | --- |
| `phone`, `department`, `job_title`, `office`, `extension_attribute_*` | Shown, never matched | **Yes**, today |
| `company` | Shown, **and grouped in Reports** | Yes, if the grouping moves into the application |
| `first_name`, `last_name`, `display_name` | Shown, **ordered by**, **searched** | Only with a sort key kept beside them |
| `email` | **The sign-in name**, SCIM matching, a unique index | Only with a blind index |

**A blind index** is the standard answer for the last row: store
`HMAC(key, lower(email))` in a second column, put the unique index on *that*,
and look up by it. Exact matches keep working; "find everybody at
contoso.com" does not, which the people directory and the CSV import both do
today.

**Ordering** is the one with no clean answer. `ORDER BY lower(display_name)`
cannot work on ciphertext. The options are a deterministic encryption that
leaks ordering (weak, and usually rejected by the same auditor who asked for
this), or sorting in the application over a capped page - which the queue
already does for SLA clocks, so there is precedent.

## Stage 3: the ticket

`tickets.title`, `tickets.description` and the comment bodies are the
service desk's actual content, and the queue searches them with `LIKE`.
Encrypt them and the search box stops working - not degrades, stops.

Three honest options, in the order I would offer them:

1. **Leave them in plaintext** and rely on the database's own encryption at
   rest (Azure Database for PostgreSQL encrypts storage by default; SQLite
   on an encrypted volume). This is what most service desks actually do, and
   it answers the stolen-disk case.
2. **Encrypt them and lose the search**, keeping reference, status, dates
   and people searchable. Say so on the page where the search box used to
   be.
3. **Encrypt them and keep a searchable index** of per-word HMACs in a side
   table. Real work, real limits (no substring, no stemming), and a
   vocabulary table that leaks word frequencies.

## What this costs everywhere else

The things easy to forget, each of which has bitten somebody:

- **Every report, filter and sort that touches an encrypted column** moves
  into the application. `services/reports.ts` groups by company today.
- **SCIM** matches by email on every provisioning cycle - the blind index
  has to be there before Entra next runs.
- **The import and export** (`data-export.ts`, shipped today) must decide
  whether they write plaintext. An export that is ciphertext is useless to
  the person who asked for their data; one that is plaintext is a copy of
  everything with no key needed. The answer is probably plaintext plus a
  warning on the page.
- **The mail poller** writes ticket text from outside a request - it needs
  the key in the same process, which it has.
- **Key rotation** needs a background pass that re-seals every row, and the
  versioned prefix is what makes that resumable.

## Asked and answered: is ciphertext better here?

The owner asked directly (16 Oct 2026) whether encrypting the ticket text
would be better. **No** - and the reasoning is worth keeping, because it is
the one judgement in this document:

- Three of the four threats encryption answers are already answered more
  cheaply: Azure encrypts the storage by default and can use a
  customer-managed key from the vault (a setting, not code), each customer
  database has its own credentials, and the provisioner puts the web apps
  behind a private endpoint. What stage 3 adds is protection from somebody
  holding one connection string but not that customer app server - narrow.
- What it costs is the search box, in four places (the shell bar, /search,
  the queue filter and the read API), and it stops rather than degrades.
- GDPR asks for measures appropriate to the risk, not for ciphertext.

**The middle path, if more than stage 1 is wanted**: encrypt the description
and the comments, leave the **title** searchable. Searching in practice is by
title, reference or person; the long free text is where somebody pastes a
password, a home address or a medical note, and it is rarely what anybody
searches by.

## What I would do

Stage 1 now - it is contained, it is the biggest practical win, and nothing
in the application has to change around it. Stage 2 next, with a blind index
on email and application-side ordering for names. Stage 3 only after the
owner has chosen, out loud, between the search box and the ciphertext.

And whatever is chosen: a line in `DEPLOYMENT.md` saying where the key lives
and what happens if it is lost.
