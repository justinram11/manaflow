variable "project_name" {
  description = "Project name prefix for all resources"
  type        = string
  default     = "cmux"
}

variable "regions" {
  description = "AWS regions to deploy to"
  type        = list(string)
  default     = ["us-east-2"]
}

variable "cmux_server_ip" {
  description = "Public IP of the central cmux server (for SSH access to workspaces)"
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.100.0.0/16"
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets (one per AZ)"
  type        = list(string)
  default     = ["10.100.1.0/24", "10.100.2.0/24"]
}

variable "default_instance_type" {
  description = "Default EC2 instance type for workspaces"
  type        = string
  default     = "t4g.2xlarge"
}

variable "root_volume_size_gb" {
  description = "EBS root volume size in GB"
  type        = number
  default     = 48
}

variable "max_workspace_instances" {
  description = "Maximum number of concurrent workspace instances (for cost control)"
  type        = number
  default     = 15
}
