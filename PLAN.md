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
- Next: route stream queries directly to DynamoDB stream indexes where useful, add S3 body store implementation, then start OpenTofu/AWS resources.
