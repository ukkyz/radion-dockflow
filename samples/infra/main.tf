terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 5.60" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.31" }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = local.common_tags
  }
}

provider "kubernetes" {
  host = module.eks.cluster_endpoint
}

locals {
  common_tags = {
    project     = var.project
    environment = var.environment
    managed_by  = "terraform"
  }
  name_prefix = "${var.project}-${var.environment}"
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  tags                 = merge(local.common_tags, { Name = "${local.name_prefix}-vpc" })
}

resource "aws_subnet" "public" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = { Name = "${local.name_prefix}-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = { Name = "${local.name_prefix}-private-${count.index}" }
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_security_group" "cluster" {
  name_prefix = "${local.name_prefix}-cluster"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

module "eks" {
  source          = "terraform-aws-modules/eks/aws"
  version         = "20.24.0"
  cluster_name    = local.name_prefix
  cluster_version = var.kubernetes_version
  vpc_id          = aws_vpc.main.id
  subnet_ids      = concat(aws_subnet.public[*].id, aws_subnet.private[*].id)

  eks_managed_node_groups = {
    api = {
      instance_types = ["m6i.large"]
      min_size       = 3
      max_size       = 12
      desired_size   = 4
      labels         = { workload = "api" }
    }
    jobs = {
      instance_types = ["c7g.xlarge"]
      min_size       = 0
      max_size       = 30
      desired_size   = 2
      labels         = { workload = "batch" }
    }
  }
}

resource "aws_db_instance" "primary" {
  identifier             = "${local.name_prefix}-pg"
  engine                 = "postgres"
  engine_version         = "16.4"
  instance_class         = var.db_instance_class
  allocated_storage      = 200
  storage_encrypted      = true
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.cluster.id]
  username               = var.db_username
  password               = var.db_password
  multi_az               = var.environment == "prod"
  backup_retention_period = 14
  skip_final_snapshot    = false
  tags                   = local.common_tags
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_replication_group" "cache" {
  replication_group_id       = "${local.name_prefix}-redis"
  description                = "Redis for ${local.name_prefix}"
  node_type                  = var.cache_node_type
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.cluster.id]
  tags                       = local.common_tags
}

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name_prefix}-cache"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_s3_bucket" "artifacts" {
  bucket = "${local.name_prefix}-artifacts"
  tags   = local.common_tags
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_iam_role" "api_task" {
  name = "${local.name_prefix}-api-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
  tags = local.common_tags
}

resource "aws_iam_role_policy" "api_task_s3" {
  name   = "${local.name_prefix}-artifacts-rw"
  role   = aws_iam_role.api_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.artifacts.arn, "${aws_s3_bucket.artifacts.arn}/*"]
      },
    ]
  })
}

resource "kubernetes_namespace" "app" {
  metadata {
    name = var.project
    labels = {
      environment = var.environment
    }
  }
}

resource "kubernetes_config_map" "api" {
  metadata {
    name      = "api-config"
    namespace = kubernetes_namespace.app.metadata[0].name
  }
  data = {
    DATABASE_HOST = aws_db_instance.primary.address
    REDIS_HOST    = aws_elasticache_replication_group.cache.primary_endpoint_address
    LOG_LEVEL     = "info"
  }
}

resource "kubernetes_secret" "api" {
  metadata {
    name      = "api-secrets"
    namespace = kubernetes_namespace.app.metadata[0].name
  }
  data = {
    DATABASE_URL = "postgres://${var.db_username}:${var.db_password}@${aws_db_instance.primary.endpoint}/vega"
  }
}

resource "kubernetes_deployment" "api" {
  metadata {
    name      = "api"
    namespace = kubernetes_namespace.app.metadata[0].name
  }
  spec {
    replicas = var.api_replicas
    selector {
      match_labels = { app = "api" }
    }
    template {
      metadata {
        labels = { app = "api" }
      }
      spec {
        container {
          name  = "api"
          image = "${var.image_registry}/vega-api:${var.image_tag}"
          env_from {
            config_map_ref { name = kubernetes_config_map.api.metadata[0].name }
            secret_ref { name = kubernetes_secret.api.metadata[0].name }
          }
          resources {
            limits = {
              cpu    = "2"
              memory = "2Gi"
            }
          }
        }
      }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${local.name_prefix}-api-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 25
  alarm_description   = "api 5xx above threshold"
  tags                = local.common_tags
}
