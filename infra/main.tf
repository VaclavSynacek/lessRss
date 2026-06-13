resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  name        = var.project_name
  name_suffix = "${var.project_name}-${random_id.suffix.hex}"
  auth_secret = var.auth_secret != "" ? var.auth_secret : var.greader_password
}

resource "aws_dynamodb_table" "main" {
  name         = local.name_suffix
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }
}

resource "aws_s3_bucket" "bodies" {
  bucket = "${local.name_suffix}-bodies"
}

resource "aws_s3_bucket_public_access_block" "bodies" {
  bucket                  = aws_s3_bucket.bodies.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.name_suffix}-api"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "crawler" {
  name              = "/aws/lambda/${local.name_suffix}-crawler"
  retention_in_days = 14
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.name_suffix}-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "lambda" {
  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = [
      "${aws_cloudwatch_log_group.api.arn}:*",
      "${aws_cloudwatch_log_group.crawler.arn}:*"
    ]
  }

  statement {
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
      "dynamodb:Query"
    ]
    resources = [aws_dynamodb_table.main.arn]
  }

  statement {
    actions = [
      "s3:GetObject",
      "s3:PutObject"
    ]
    resources = ["${aws_s3_bucket.bodies.arn}/*"]
  }
}

resource "aws_iam_role_policy" "lambda" {
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

resource "null_resource" "lambda_build" {
  triggers = {
    src_hash          = sha256(join("", [for f in fileset("${path.module}/..", "src/**") : filesha256("${path.module}/../${f}")]))
    package_hash      = filesha256("${path.module}/../package-lock.json")
    build_script_hash = filesha256("${path.module}/../scripts/build-lambda.js")
  }

  provisioner "local-exec" {
    command     = "npm run build:lambda"
    working_dir = "${path.module}/.."
  }
}

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../build/lambda"
  output_path = "${path.module}/../build/lambda.zip"

  depends_on = [null_resource.lambda_build]
}

locals {
  lambda_env = {
    LESSRSS_STORAGE     = "dynamodb"
    LESSRSS_DDB_TABLE   = aws_dynamodb_table.main.name
    LESSRSS_BODY_STORE  = "s3"
    LESSRSS_BODY_BUCKET = aws_s3_bucket.bodies.bucket
    GREADER_USER        = var.greader_user
    GREADER_PASSWORD    = var.greader_password
    LESSRSS_AUTH_SECRET = local.auth_secret
    NODE_OPTIONS        = "--enable-source-maps"
  }
}

resource "aws_lambda_function" "api" {
  function_name    = "${local.name_suffix}-api"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "src/handler.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = var.lambda_timeout_seconds
  memory_size      = var.lambda_memory_mb

  environment {
    variables = local.lambda_env
  }

  depends_on = [aws_iam_role_policy.lambda, aws_cloudwatch_log_group.api]
}

resource "aws_lambda_function" "crawler" {
  function_name    = "${local.name_suffix}-crawler"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "src/crawler-handler.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = var.crawler_timeout_seconds
  memory_size      = var.lambda_memory_mb

  environment {
    variables = local.lambda_env
  }

  depends_on = [aws_iam_role_policy.lambda, aws_cloudwatch_log_group.crawler]
}

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"
}

resource "aws_cloudwatch_event_rule" "crawler" {
  name                = "${local.name_suffix}-crawler"
  schedule_expression = var.crawler_schedule_expression
}

resource "aws_cloudwatch_event_target" "crawler" {
  rule      = aws_cloudwatch_event_rule.crawler.name
  target_id = "crawler"
  arn       = aws_lambda_function.crawler.arn
}

resource "aws_lambda_permission" "events_crawler" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.crawler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.crawler.arn
}
