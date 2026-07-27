# Security

lessRss treats feed XML and article content as hostile. Feed downloads are limited to 20 MiB and ten redirects; ordinary feed fields are limited to 8 KiB. Only HTTP(S) URLs are retained, and article HTML is sanitized with iframes removed.

This is a single-user server: it does not defend against a malicious authenticated client, provide session expiry or rate limiting, or automatically rotate credentials. Private and localhost feed targets are intentionally allowed for self-hosted feeds and testing; operators should restrict network egress if SSRF to reachable services is a concern.
