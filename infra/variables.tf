variable "project_name" {
  type        = string
  description = "Resource name prefix."
  default     = "lessrss"
}

variable "greader_user" {
  type        = string
  description = "Single Google Reader API username."
}

variable "greader_password" {
  type        = string
  description = "Single Google Reader API password."
  sensitive   = true
}

variable "auth_secret" {
  type        = string
  description = "HMAC secret for auth/post tokens. Defaults to greader_password if empty."
  sensitive   = true
  default     = ""
}

variable "crawler_schedule_expression" {
  type        = string
  description = "EventBridge schedule for feed refresh."
  default     = "rate(2 hours)"
}

variable "lambda_timeout_seconds" {
  type    = number
  default = 60
}

variable "crawler_timeout_seconds" {
  type    = number
  default = 600
}

variable "crawler_feed_timeout_ms" {
  type        = number
  description = "Per-feed crawler fetch timeout in milliseconds."
  default     = 30000
}

variable "crawler_concurrency" {
  type        = number
  description = "Maximum number of feeds crawled concurrently."
  default     = 5
}

variable "api_memory_mb" {
  type        = number
  description = "Memory (MB) for the API Lambda function."
  default     = 512
}

variable "crawler_memory_mb" {
  type        = number
  description = "Memory (MB) for the crawler Lambda function. I/O-bound; peaks well below 256MB."
  default     = 256
}
