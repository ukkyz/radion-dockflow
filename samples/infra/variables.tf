variable "project" {
  description = "Project name used for resource naming"
  type        = string
  default     = "vega"
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod"
  }
}

variable "region" {
  type    = string
  default = "eu-central-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "admin_cidr" {
  description = "CIDR allowed to reach the cluster API"
  type        = string
  default     = "10.0.0.0/8"
}

variable "kubernetes_version" {
  type    = string
  default = "1.30"
}

variable "db_instance_class" {
  type    = string
  default = "db.r6g.xlarge"
}

variable "db_username" {
  type      = string
  sensitive = true
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "cache_node_type" {
  type    = string
  default = "cache.r7g.large"
}

variable "api_replicas" {
  type    = number
  default = 4
}

variable "image_registry" {
  type    = string
  default = "ghcr.io/vega"
}

variable "image_tag" {
  type    = string
  default = "2.14.3"
}

variable "unused_legacy_flag" {
  description = "left over from the 1.x rollout, nothing references it anymore"
  type        = bool
  default     = false
}
