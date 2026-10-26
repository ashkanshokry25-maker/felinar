terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0" # validated with 6.69.1 (2026-10-17)
    }
  }
}

provider "aws" {
  region = var.region
}

# CloudFront certificates and CLOUDFRONT-scope WAF ACLs must live in us-east-1.
provider "aws" {
  alias  = "use1"
  region = "us-east-1"
}
