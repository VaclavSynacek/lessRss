variable "aws_region" {
  type        = string
  description = "AWS region to deploy into."
  default     = "eu-central-1"
}

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
  default     = "rate(15 minutes)"
}

variable "lambda_timeout_seconds" {
  type    = number
  default = 60
}

variable "crawler_timeout_seconds" {
  type    = number
  default = 300
}

variable "lambda_memory_mb" {
  type    = number
  default = 512
}
