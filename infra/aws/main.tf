# cmux AWS Workspace Infrastructure
#
# Deploys per-region: VPC, subnets, security groups, IAM roles.
# Workspaces use Tailscale for networking — no public workspace ports.
#
# Usage:
#   cd infra/aws
#   terraform init
#   terraform plan -var="cmux_server_ip=1.2.3.4"
#   terraform apply -var="cmux_server_ip=1.2.3.4"

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.regions[0]
}

# ---------------------------------------------------------------------------
# Data sources
# ---------------------------------------------------------------------------

data "aws_availability_zones" "available" {
  state = "available"
}

# ---------------------------------------------------------------------------
# VPC
# ---------------------------------------------------------------------------

resource "aws_vpc" "workspace" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${var.project_name}-workspace-vpc"
  }
}

resource "aws_internet_gateway" "workspace" {
  vpc_id = aws_vpc.workspace.id

  tags = {
    Name = "${var.project_name}-workspace-igw"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.workspace.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.workspace.id
  }

  tags = {
    Name = "${var.project_name}-workspace-public-rt"
  }
}

resource "aws_subnet" "public" {
  count = length(var.public_subnet_cidrs)

  vpc_id                  = aws_vpc.workspace.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.project_name}-workspace-public-${count.index}"
  }
}

resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# ---------------------------------------------------------------------------
# Security Groups
# ---------------------------------------------------------------------------

# Workspace instances: only SSH from cmux server, all outbound.
# Dev access happens over Tailscale (no public workspace ports).
resource "aws_security_group" "workspace" {
  name_prefix = "${var.project_name}-workspace-"
  description = "cmux workspace instances - SSH from server only, outbound all"
  vpc_id      = aws_vpc.workspace.id

  # SSH from cmux server (for initial provisioning before Tailscale is up)
  ingress {
    description = "SSH from cmux server"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["${var.cmux_server_ip}/32"]
  }

  # Tailscale UDP (WireGuard) — needed for direct connections
  ingress {
    description = "Tailscale WireGuard"
    from_port   = 41641
    to_port     = 41641
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # All outbound (workspaces need internet for git, npm, etc.)
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-workspace-sg"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# ---------------------------------------------------------------------------
# IAM — Instance Profile for Workspaces
# ---------------------------------------------------------------------------

resource "aws_iam_role" "workspace" {
  name = "${var.project_name}-workspace-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "${var.project_name}-workspace-role"
  }
}

# Minimal permissions: SSM for emergency access, CloudWatch for logs
resource "aws_iam_role_policy" "workspace" {
  name = "${var.project_name}-workspace-policy"
  role = aws_iam_role.workspace.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # SSM agent for emergency access (backup if Tailscale fails)
        Effect = "Allow"
        Action = [
          "ssm:UpdateInstanceInformation",
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "workspace" {
  name = "${var.project_name}-workspace-profile"
  role = aws_iam_role.workspace.name
}

# ---------------------------------------------------------------------------
# IAM — cmux Server Policy (for managing EC2 instances)
# ---------------------------------------------------------------------------

resource "aws_iam_policy" "cmux_server" {
  name        = "${var.project_name}-server-ec2-policy"
  description = "Permissions for the cmux server to manage workspace EC2 instances"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ec2:RunInstances",
          "ec2:StartInstances",
          "ec2:StopInstances",
          "ec2:TerminateInstances",
          "ec2:DescribeInstances",
          "ec2:DescribeInstanceStatus",
          "ec2:CreateImage",
          "ec2:CopyImage",
          "ec2:DeregisterImage",
          "ec2:DescribeImages",
          "ec2:DescribeSnapshots",
          "ec2:DeleteSnapshot",
          "ec2:CreateTags",
          "ec2:DescribeTags",
        ]
        Resource = "*"
      },
      {
        # Allow the server to pass the workspace instance profile role
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = aws_iam_role.workspace.arn
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "vpc_id" {
  value = aws_vpc.workspace.id
}

output "subnet_ids" {
  value = aws_subnet.public[*].id
}

output "security_group_id" {
  value = aws_security_group.workspace.id
}

output "instance_profile_name" {
  value = aws_iam_instance_profile.workspace.name
}

output "server_policy_arn" {
  value = aws_iam_policy.cmux_server.arn
}

# Convenience: environment variables to set on the cmux server
output "cmux_env_vars" {
  value = <<-EOT
    AWS_EC2_REGION=${var.regions[0]}
    AWS_EC2_SUBNET_IDS={"${var.regions[0]}":"${aws_subnet.public[0].id}"}
    AWS_EC2_SECURITY_GROUP_IDS={"${var.regions[0]}":"${aws_security_group.workspace.id}"}
  EOT
}
