# Giveaway Runner

Run giveaways with weighted entries and a server-side random draw. Every prize gets its own barcode label that can be printed and scanned. The front end is a single `index.html`, the API is one Netlify function, and Airtable is the backend.

## 1. Airtable base

Create a base with these three tables. Field names must match exactly (they're case-sensitive). Use **Single line text** unless noted.

**Giveaways**
| Field | Type |
|---|---|
| Name | Single line text (primary) |

**Entries**
| Field | Type |
|---|---|
| Username | Single line text (primary) |
| Count | Number (integer) |
| GiveawayId | Single line text |

**Prizes**
| Field | Type |
|---|---|
| Name | Single line text (primary) |
| SKU | Single line text (this is the barcode value) |
| GiveawayId | Single line text |
| Status | Single line text or Single select (Available / Won / Shipped) |
| Winner | Single line text |
| WinnerEntries | Number (integer) |
| WonAt | Single line text (ISO timestamp) |

`GiveawayId` holds the Airtable record id of the giveaway (`rec…`). It's plain text on purpose so lookups never depend on linked-record names.

## 2. Token

Go to airtable.com/create/tokens and create a token with the scopes `data.records:read` and `data.records:write`, with access to this base only. Copy the token immediately, because you can't view it again later.

## 3. GitHub, then Netlify

1. Push this folder to a new GitHub repo.
2. In Netlify, choose Add new site → Import from Git and pick the repo. No build command is needed; publish dir `.` comes from `netlify.toml`.
3. Under Site configuration → Environment variables, add:
   - `AIRTABLE_TOKEN`: the token
   - `AIRTABLE_BASE_ID`: the `app…` id from the base URL
   - `ADMIN_KEY`: any passphrase. The site asks for it once per device, so random people who find the URL can't touch your data.
4. Trigger a redeploy so the function picks up the env vars.

Don't drag-and-drop deploy: that path skips the function.

## Using it

- **Prizes:** add a prize and leave the barcode blank to get a generated `PRZ-XXXXXXX` code, or scan the item's existing UPC into the barcode box. Use Print label to print a label, and click a barcode to show it full screen.
- **Scan box (top bar):** scan any prize label to see its giveaway, status, and winner, and to mark it shipped.
- **Entries:** enter a username plus an entry count (the default is 1). Adding a username that's already in adds to their total. Matching is case-insensitive.
- **Draw:** pick the prize, then draw. The server pulls the live entries from Airtable, picks with `crypto.randomInt` weighted by entries, writes the winner to the prize record, and optionally removes the winner from the pool.

## Before committing changes

```
node --check netlify/functions/api.js
```
