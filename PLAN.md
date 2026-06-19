# lessRss implementation plan

## Goal

Build a single-user, AWS-serverless RSS backend exposing a Google Reader compatible API. Development is local-first: pass `../google-reader-api-tests/` locally before adding OpenTofu/AWS deployment.

## Constraints and decisions

- Runtime language: plain Node.js / JavaScript.
- Local API simulation: custom lightweight HTTP wrapper around the same handler that will run in Lambda.
- Avoid SAM.
- Local storage: use filesystem where practical; use storage abstractions so AWS versions can replace local implementations.
- AWS storage target:
  - DynamoDB for query/index/state metadata.
  - S3 for every item body/content object, always.
- Local body storage: filesystem, under `.local-data/bodies/`, mirroring S3 object keys.
- Single-user only: GReader credentials are environment variables.
- Deployment later via OpenTofu only after local conformance is working.

## Test target

Contract suite lives at `../google-reader-api-tests/`.

Local env shape:

```sh
export GREADER_BASE_URL=http://127.0.0.1:3000/api/greader.php
export GREADER_USER=alice
export GREADER_PASSWORD=secret
npm --prefix ../google-reader-api-tests test
```

The local API/crawler must be able to reach the test suite's in-process feed server, so ingestion tests should be runnable locally.

AWS-side ingestion tests may be skipped initially because Lambda cannot reach a localhost feed server on the test machine.

## Local architecture

```text
src/local-server.js       local HTTP wrapper
src/handler.js            Lambda-compatible handler entry point
src/router.js             GReader route dispatch
src/auth.js               ClientLogin/Auth/token handling
src/storage.js            storage interface + local filesystem implementation for early work
src/body-store.js         local filesystem body store now, S3 implementation later
src/greader-format.js     stream/item JSON formatting
src/crawler.js            feed fetching/parsing/upsert
```

Early local metadata may use a filesystem implementation to keep iteration fast. Before AWS deployment, add a DynamoDB-backed metadata implementation and run the same API tests against it locally using DynamoDB Local or direct AWS in the deployed stage.

## DynamoDB target model

Single-table design with `PK`/`SK` keys.

Metadata rows:

```text
PK=USER                 SK=META
PK=USER                 SK=SUB#<feedId>
PK=ITEM#<itemId>         SK=META
PK=STREAM#ALL            SK=<reverseTimestamp>#<itemId>
PK=STREAM#FEED#<feedId>  SK=<reverseTimestamp>#<itemId>
PK=STREAM#UNREAD         SK=<reverseTimestamp>#<itemId>
PK=STREAM#FEED#<feedId>#UNREAD SK=<reverseTimestamp>#<itemId>
PK=STREAM#STARRED        SK=<reverseTimestamp>#<itemId>
PK=STREAM#LABEL#<label>  SK=<reverseTimestamp>#<itemId>
PK=COUNT                 SK=READING_LIST / FEED#<feedId> / LABEL#<label>
```

All item bodies/content live outside DynamoDB:

```text
items/<feedId>/<itemId>.json
```

Local path:

```text
.local-data/bodies/items/<feedId>/<itemId>.json
```

AWS path:

```text
s3://<bucket>/items/<feedId>/<itemId>.json
```

## Implementation phases

### Phase 1: skeleton and empty-state API

- Create package scripts.
- Add local server and Lambda-style handler.
- Implement auth:
  - `POST /accounts/ClientLogin`
  - `GET /reader/api/0/token`
  - reject missing/bad `Authorization` with HTTP 401.
- Implement empty-state read endpoints:
  - `user-info`
  - `tag/list`
  - `subscription/list`
  - `unread-count`
  - empty `stream/contents`
  - empty `stream/items/ids`
  - empty `stream/items/contents`
- Expected: auth and most read tests pass; item-shape tests skip on empty state.

### Phase 2: subscriptions and OPML

- Filesystem metadata store for subscriptions.
- `subscription/edit` subscribe/unsubscribe.
- `subscription/quickadd`.
- `subscription/export` OPML.
- `subscription/import` OPML accept path.
- Make import call crawler refresh hook.

### Phase 3: crawler and item ingestion

- Fetch RSS/Atom feeds with built-in `fetch`.
- Parse enough RSS 2.0 and Atom for the contract feed and common feeds.
- Stable feed IDs from URL hash.
- Stable item IDs from feed ID + guid/link hash.
- Store item metadata in metadata store.
- Store item body JSON in body store.
- Preserve read/starred/label state across item updates.
- Expected: ingestion tests pass locally.

### Phase 4: full stream and mutation support

- `stream/contents` for reading-list, starred, feed streams, labels.
- `stream/items/ids` with decimal item ids.
- `stream/items/contents` hydrate repeated `i` fields.
- Sorting: default/newest descending, `r=o` ascending.
- Filters: `n`, `ot`, `nt`, `xt=read`.
- `edit-tag` read/starred/label add/remove.
- `mark-all-as-read`.
- `rename-tag`, `disable-tag`.
- `unread-count` from metadata indexes/state.
- Expected: full local contract suite passes.

### Phase 5: DynamoDB Local metadata backend

- Add DynamoDB metadata implementation.
- Use DynamoDB Local for local parity where helpful.
- Keep filesystem backend available for fast/debug local runs.
- Re-run full local suite against DynamoDB backend.

### Phase 6: AWS deployment

- Add OpenTofu resources:
  - DynamoDB table.
  - S3 bucket.
  - API Lambda.
  - crawler Lambda.
  - API Gateway HTTP API.
  - EventBridge schedule.
  - IAM policies.
  - log groups.
- Add S3 body store implementation.
- Deploy and run contract tests with ingestion skipped initially:

```sh
GREADER_SKIP_INGESTION=1 npm --prefix ../google-reader-api-tests test
```

### Phase 7: AWS ingestion strategy

- Either expose the contract feed through a public/tunneled URL and set `GREADER_FEED_PUBLIC_URL`, or skip ingestion against AWS and rely on local ingestion conformance plus AWS crawler smoke tests.

## Progress notes

- 2026-06-13: Created this plan.
- 2026-06-13: Implemented initial local-first server skeleton:
  - custom local HTTP Lambda wrapper (`src/local-server.js`), no SAM;
  - Lambda-compatible handler/router;
  - env-var single-user auth and GReader post token;
  - local filesystem metadata store and local filesystem body store;
  - subscription lifecycle, OPML import/export, stream endpoints, read/starred mutations;
  - simple RSS/Atom crawler with OPML-import refresh hook.
- 2026-06-13: Local full contract suite passed against filesystem backend:
  - command used: `GREADER_BASE_URL=http://127.0.0.1:3102/api/greader.php GREADER_USER=alice GREADER_PASSWORD=secret GREADER_TIMEOUT_MS=20000 GREADER_INGESTION_TIMEOUT_MS=20000 GREADER_INGESTION_POLL_MS=1000 npm --prefix ../google-reader-api-tests test`
  - result: 31 pass, 0 fail.
- 2026-06-13: Added metadata storage backend selector and DynamoDB metadata backend using `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb`.
- 2026-06-13: Added `docker-compose.yml` for official `amazon/dynamodb-local` in `-inMemory -sharedDb` mode and `scripts/create-dynamodb-table.js`.
- 2026-06-13: DynamoDB Local full contract suite passed:
  - setup: `docker compose up -d dynamodb && npm run db:create`
  - server: `LESSRSS_STORAGE=dynamodb DYNAMODB_ENDPOINT=http://127.0.0.1:8000 LESSRSS_DATA_DIR=$PWD/.local-data-ddb-test GREADER_USER=alice GREADER_PASSWORD=secret PORT=3104 node src/local-server.js`
  - tests: `GREADER_BASE_URL=http://127.0.0.1:3104/api/greader.php GREADER_USER=alice GREADER_PASSWORD=secret GREADER_TIMEOUT_MS=20000 GREADER_INGESTION_TIMEOUT_MS=20000 GREADER_INGESTION_POLL_MS=1000 npm --prefix ../google-reader-api-tests test`
  - result: 31 pass, 0 fail.
- 2026-06-13: Updated DynamoDB backend to maintain stream index rows for all/feed/unread/starred/label streams and use `STREAM#ALL` for `listItems()` instead of table scans.
- 2026-06-13: Re-ran DynamoDB Local contract suite after stream indexes:
  - result: 29 pass, 0 fail, 2 skipped by test preconditions (`not enough items`), so no regressions.
- 2026-06-13: Added `listStreamItems()` storage API and routed stream reads through it. DynamoDB backend now queries stream index partitions directly for API stream reads instead of going through a generic full item listing.
- 2026-06-13: Split body storage into selectable backends with `LESSRSS_BODY_STORE=fs|s3`; added S3 implementation using `@aws-sdk/client-s3` while keeping filesystem as local default.
- 2026-06-13: Added explicit crawler Lambda-style entrypoint `src/crawler-handler.js` plus `npm run refresh` for local/manual refresh.
- 2026-06-13: Hardened filesystem metadata writes with an in-process write lock to prevent local concurrent test requests from clobbering state.
- 2026-06-13: Re-ran contract tests:
  - filesystem backend: 31 pass, 0 fail;
  - DynamoDB Local backend with direct stream index reads: 29 pass, 0 fail, 2 skipped by empty/precondition checks.
- 2026-06-13: Added OpenTofu AWS configuration for DynamoDB, S3 body bucket, API Lambda, crawler Lambda, Lambda Function URL endpoint, EventBridge schedule, IAM, logs, and outputs.
- 2026-06-13: Added Lambda package build script and validated OpenTofu locally with `tofu -chdir=infra init -backend=false` and `tofu -chdir=infra validate`.
- 2026-06-13: Confirmed AWS caller identity is available in the shell. Deployment is blocked only on choosing/providing GReader API credentials as OpenTofu variables (`TF_VAR_greader_user`, `TF_VAR_greader_password`, optional `TF_VAR_auth_secret`).
- 2026-06-13: Replaced API Gateway with Lambda Function URL; API Gateway is unnecessary for this single-user app because GReader auth is handled in application code and Function URL supports the needed path routing.
- 2026-06-15: Kept `infra/` usable as an OpenTofu module by moving AWS provider region configuration to the consuming/root configuration.
- 2026-06-13: Deployed a temporary AWS test stack with dummy GReader credentials after explicit approval.
- 2026-06-13: Lambda Function URL initially returned AWS 403 despite `authorization_type = NONE`; fixed by adding Lambda URL resource policy permissions for both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`.
- 2026-06-13: AWS contract suite passed with ingestion skipped: 24 pass, 0 fail, 7 skipped. Skips are expected because AWS Lambda cannot reach the local contract feed server and the remote state had no persistent feed items after cleanup.
- 2026-06-13: Destroyed the temporary AWS test stack after explicit request. Future AWS ingestion testing should be done from an EC2-hosted test runner or another environment where the feed fixture is reachable by Lambda.
- Next: in a future AWS session, deploy again and run ingestion tests from EC2 or with a public/tunneled feed fixture.

## AWS cost and latency review (2026-06-19)

Reviewed real CloudWatch metrics against the live personal deployment (`lessrss-ac893178` in `eu-central-1`). The AWS account predates the 12-month Free Tier, so only Always-Free limits apply.

### Steady-state cost (24h measurement, annualized)

- Lambda: ~5,260 req/month, ~11,200 GB-s/month. Comfortably inside the Always-Free 1M req + 400k GB-s tier. Cost: $0.
- DynamoDB (on-demand): ~545k RCU + ~219k WCU/month, 0.85 MB storage. Throughput is never free on on-demand; this is the only meaningful line item at ~$0.40/month.
- S3 / CloudWatch Logs / EventBridge: negligible.
- **Realistic monthly bill at current usage: ~$0.40/month, almost entirely DynamoDB on-demand.**

### Lessons learned / changes shipped

1. **Initial-crawl bias matters when measuring.** The first 7-day window was dominated by the one-time full crawl (S3 peaked at 45 MB / 2,464 objects before settling to 12 MB / 898). Steady-state measurement over the last 24h gave a much lower and more representative picture.
2. **`lastFetchAt` / `lastSuccessAt` / `lastStatus` / `lastError` on subscription rows were dead code** — written every refresh, never read anywhere. Dropped them; the crawler now writes a subscription row only when `etag` or `lastModified` actually changed (304s and 200-with-same-headers write nothing). This extends the existing no-write-on-no-change rule from items to subscriptions. Commit `af5a887`.
3. **Concurrency is not a Lambda cost lever; RAM is.** Lambda bills GB-s = memory × duration summed over all concurrent invocations, so parallelizing work changes wall-clock but not bill. Raising concurrency only helps if there is a wall-clock problem (timeouts, freshness). Verified via CloudWatch: crawler max concurrent executions = 1, no throttles, no wall-clock problem.
4. **Crawler Lambda memory is overprovisioned.** `@maxMemoryUsed` peaked at 182 MB of the configured 512 MB over 7 days. Lowered crawler to 256 MB. Split the shared `lambda_memory_mb` variable into `api_memory_mb` (512, unchanged) and `crawler_memory_mb` (256). Commit `732be27`.
5. **API read path had two independent serial-await bottlenecks**, both of which made latency scale with item count:
   - `router.streamContents` / `streamItemsContents` hydrated S3 bodies in a serial `for await`; default `n=20` meant up to 20 sequential S3 GetObjects. Parallelized via shared `mapLimit` (cap 20, env `LESSRSS_BODY_FETCH_CONCURRENCY`). Commit `58bc14c`.
   - `storage-dynamodb.listStreamItems` -> `getItems` did serial DynamoDB GetItems per row, and `queryAll` paginated the entire stream before slicing to `n`. Parallelized `getItems` (cap 20, env `LESSRSS_DDB_GET_CONCURRENCY`) and pushed a `Limit` of `max(n, n*5)` (capped 1000) into the Query with oversample headroom for `filterPostQuery`. Commit `1a51d97`.
6. **`mapLimit` extracted to `src/async-util.js`** and reused by crawler and storage-dynamodb.

### Measured latency impact (live, end-to-end including network)

- `stream/contents` n=20 (default reading-list): ~8s -> ~1.5s (about 5x faster).
- n=5: ~8s -> ~0.4s.
- n=50: ~20s+ -> ~3.4s.
- API-side p50 dropped from bimodal (15ms fast / 8-24s slow hydration) to consistently fast; exact post-fix distribution TBD after a day or two of real Android-client traffic.

### Open follow-ups

- Re-measure API duration distribution after 1-2 days of real client traffic to confirm the latency fix and re-check cost.
- If n=20 list views are still perceived as slow, the next lever is a schema change: store a short `summarySnippet` in the DynamoDB item row so list views can skip S3 entirely and fall back to S3 only for full-body fetch. This needs confirming whether the (unchangeable) Android client tolerates a truncated `summary` in `stream/contents` versus requiring the full body inline.
- Streaming the response (Lambda Function URL `ResponseStream`) was evaluated and rejected: GReader JSON is a single parseable object so incremental rendering is not possible, and the bottleneck was server-side serial I/O, not transfer.
- Raising API Lambda memory (512 -> 1024) is the inverse of the crawler change and may help if JSON serialization or sanitize-html becomes a hot path after the I/O fixes; measure first.
