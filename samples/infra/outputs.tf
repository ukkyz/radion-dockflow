output "cluster_endpoint" {
  description = "EKS API server endpoint"
  value       = module.eks.cluster_endpoint
}

output "cluster_name" {
  value = module.eks.cluster_name
}

output "database_endpoint" {
  description = "Primary postgres endpoint"
  value       = aws_db_instance.primary.endpoint
  sensitive   = true
}

output "cache_endpoint" {
  value = aws_elasticache_replication_group.cache.primary_endpoint_address
}

output "namespace" {
  value = kubernetes_namespace.app.metadata[0].name
}

output "artifacts_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "legacy_dns_name" {
  description = "kept for backwards compatibility, the load balancer was removed"
  value       = aws_legacy_alb.dns_name
}
