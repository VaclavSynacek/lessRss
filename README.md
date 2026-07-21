# lessRss

lessRss is an experimental, single-user RSS server exposing a Google Reader-compatible API. Unlike traditional RSS servers, it is headless and serverless: there is no web UI or continuously running application server. The AWS deployment uses Lambda for the API and crawler, DynamoDB for metadata, S3 for article bodies, and EventBridge for scheduled refreshes.

It currently works for its author and with the [Read You](https://github.com/Ashinch/ReadYou) client, but it should be treated as **alpha software**. Expect missing API behavior, rough operational edges, and incompatible clients.

Protocol compatibility is checked with the separate [google-reader-api-tests](https://github.com/VaclavSynacek/google-reader-api-tests) suite, which can also run against FreshRSS and Miniflux for comparison.

## Deploying to AWS

Install the Lambda dependencies:

```sh
npm ci
```

The `infra/` directory is a Terraform-compatible module. The smallest deployment can be a sibling directory containing one `main.tf`:

```hcl
provider "aws" {
}

module "lessrss" {
  source = "../lessRss/infra"

  greader_user     = "YOUR-USER-NAME"
  greader_password = "YOUR-PASSWORD"
}

output "greader_base_url" {
  value = module.lessrss.greader_base_url
}
```
(there are more optional configuration variables, but username and password are
the only mandatory ones to get started)

With AWS credentials configured, initialize and apply this configuration using Terraform or OpenTofu. Use the resulting `greader_base_url`, username, and password when configuring a Google Reader-compatible client.

The deployment creates Lambda functions, a public Lambda Function URL, DynamoDB and S3 storage, and an EventBridge refresh schedule. API requests still require lessRss application-level authentication. Destroying the stack removes its AWS resources and stored feed data. AWS usage may incur charges.

