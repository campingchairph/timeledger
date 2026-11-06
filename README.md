# TimeLedger

An evidence-first freelance work tracker: log work, keep supporting files, record the hours each client **approves**, and calculate earnings from approved hours only — across multiple employers, contracts and currencies.

**Live app:** https://campingchairph.github.io/timeledger/

It is a static, installable PWA: no build step, no framework, no dependencies, no server. Everything runs in the browser and is stored privately on the device.

## The five numbers it never mixes up

| | Meaning | Affects earnings? |
|---|---|---|
| **Logged** | Time you recorded as worked (journal or timer) | No |
| **Submitted** | Hours in a timesheet you sent for review | No |
| **Approved** | Hours you manually record as approved by the client | **Yes — the only input** |
| **Invoiced** | Amounts on invoices (allocated against approvals) | No |
| **Paid** | Money actually received | No |

`Earned = Σ approved hours × the rate effective on that work date`, in the contract's currency. Amounts in different currencies are never added together; the home-currency (PHP) figure is always labelled as an estimate with its rate, source and timestamp.

## Run it

```bash
cd timeledger
python -m http.server 8097
```

Open http://localhost:8097. (Any static server works. Opening `index.html` directly from disk does not, because ES modules need http.)

Run the unit tests (Node 20+, nothing to install):

```bash
npm test
```

## Deploy

Push to `main` — GitHub Pages serves the repository root. After changing any app file, bump `VERSION` in `sw.js` so installed copies pick up the update.

## Using it

- **First run** shows the seeded profile, employer and contract. They are ordinary records — confirm or edit them.
- **Add employers & contracts:** *Employers & Contracts → Add employer*, then *Add contract*. Each contract has its own currency, timezones, approval contact, payment terms and effective-dated rates (*Rates → Add new rate* closes the previous rate the day before).
- **Switch scope** with the selector in the header: *All employers*, one employer, or one contract. Dashboard, journal, salary and reports follow it. The personal daily availability limit always counts all employers.
- **Log time** in the *Daily Journal* or with the *Timer* (the timer survives refreshes and only ever creates logged time).
- **Record approvals** under *Approved Hours*. Corrections require a reason and keep the previous value. Duplicate approvals for the same contract + period are blocked unless marked as an adjustment.
- **Invoices** are built from approved hours not yet allocated, so nothing is invoiced twice. Crediting an invoice releases its hours. Payments can be partial.
- **Archive, don't delete.** Archived employers/contracts leave the pickers but keep every record. Hard delete is available with a typed confirmation and a list of linked records.

## Reports

*Reports* supports eight report types (daily, detailed timesheet, reconciliation, earnings, invoice support pack, evidence register, contract summary, multi-employer summary) for one contract, one employer or all employers, over a single date, custom range, week, month, 14-day period (per-contract anchor), 14th-of-month cycle, contract-to-date or the entire contract.

- **PDF:** *Print / save PDF* opens the print dialog — choose “Save as PDF”.
- **CSV / JSON:** downloads the same data.
- **Header:** pre-filled from the employer and profile records and editable for one export. The exact header used is saved in *Export history* and *Re-run* reproduces it, even after the employer record changes.

## Backups and storage

Data is stored in the browser's IndexedDB for this site, on this device only. The app asks the browser to mark storage as persistent, but **clearing site data or losing the device loses anything not backed up**.

- **Back up:** *Settings & Backups → Download full backup* (JSON including evidence files as base64). Keep copies somewhere safe.
- **Restore:** *Restore from backup…* replaces everything on this device after a typed confirmation.
- **Export:** time entries as CSV from Settings; any report as CSV/JSON from Reports.

Evidence files are stored as the original bytes with a SHA-256 hash and are never modified; editing evidence only changes its description and links. Records are organised supporting documentation, not legally conclusive evidence.

## Exchange rates

Rates come from Frankfurter (ECB reference rates) with ExchangeRate-API's open endpoint as a fallback (`js/fx.js` — providers are swappable). They refresh every 15–60 minutes (configurable), are cached, and show a stale warning when a refresh fails. If no rate has ever been fetched, no estimate is shown. Manual overrides are available on the Salary page and are labelled wherever they're used.

## Code map

| Path | Purpose |
|---|---|
| `index.html`, `css/app.css` | Shell and styles (light/dark, mobile-first, desktop sidebar ≥900px) |
| `js/app.js` | Router, header switcher, live clocks, quick-add, onboarding, background FX refresh |
| `js/db.js` | IndexedDB tables and versioned migrations |
| `js/store.js` | In-memory mirror, `save()`/`remove()` with audit log, scope helpers |
| `js/seed.js` | First-run seed — the only place employer-specific values appear |
| `js/calc.js` | Pure money/hours/date maths (integer cents and centihours) — fully tested |
| `js/tz.js` | IANA time-zone helpers via `Intl` (no hardcoded offsets) |
| `js/metrics.js` | Aggregations: logged / submitted / approved / invoiced / paid |
| `js/fx.js` | Exchange-rate providers, caching, staleness |
| `js/actions.js` | Shared forms and workflows (entries, tasks, evidence, approvals, timer) |
| `js/report-render.js` | Report data model → print HTML / CSV |
| `js/views/*.js` | One lazily-loaded module per screen |
| `sw.js`, `manifest.webmanifest` | Offline support and install |
| `tests/` | `node --test` unit tests |

## Performance notes

- No framework or bundle: about 220 KB of uncompressed, unminified JS in total, and each screen's module is only loaded when you open it.
- All records are read from IndexedDB once at startup; screens render synchronously from memory and store writes are batched into one render per frame.
- Clocks and timers update text nodes once a second without re-rendering.
- Evidence thumbnails are generated once at upload; full files are only read when opened.
- The service worker serves the app shell from cache (works offline) and refreshes it in the background.
