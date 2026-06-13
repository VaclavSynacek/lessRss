output "greader_base_url" {
  description = "Base URL for GREADER_BASE_URL."
  value       = "${aws_lambda_function_url.api.function_url}api/greader.php"
}

output "api_endpoint" {
  value = aws_lambda_function_url.api.function_url
}

output "dynamodb_table" {
  value = aws_dynamodb_table.main.name
}

output "body_bucket" {
  value = aws_s3_bucket.bodies.bucket
}

output "api_lambda_name" {
  value = aws_lambda_function.api.function_name
}

output "crawler_lambda_name" {
  value = aws_lambda_function.crawler.function_name
}
