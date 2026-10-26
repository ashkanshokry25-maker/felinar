variable "region" {
  description = "Region for the S3 origin bucket."
  type        = string
  default     = "ca-central-1"
}

variable "name" {
  description = "Resource name prefix."
  type        = string
  default     = "mw-hub"
}

variable "sites_domain" {
  description = "Registrable domain that serves <label>.<sites_domain>, e.g. hub-sites.example. Keep it SEPARATE from control_domain (blast radius: Safe Browsing / registrar action) and submit it to the Public Suffix List once eligible."
  type        = string
}

variable "sites_zone_id" {
  description = "Route 53 public hosted zone id of sites_domain."
  type        = string
}

variable "control_domain" {
  description = "Domain of the control plane (landing page, docs, abuse contact, hub.json). Not served by this module."
  type        = string
}

variable "bucket_name" {
  description = "Globally unique S3 bucket name for the shell."
  type        = string
}

variable "enable_waf" {
  description = "Attach a WAF web ACL with a per-IP rate-based rule (required if you later subscribe to a CloudFront flat-rate plan)."
  type        = bool
  default     = true
}

variable "waf_ip_limit_per_5min" {
  description = "Requests per IP per 5 minutes before the WAF blocks the IP."
  type        = number
  default     = 1500
}

variable "price_class" {
  type    = string
  default = "PriceClass_100"
}

variable "psl_pr_url" {
  description = "URL of your publicsuffix/list pull request. When set, publishes the _psl TXT record the PSL maintainers use to authenticate the PR. Leave it in place afterwards."
  type        = string
  default     = ""
}

variable "abuse_mailbox" {
  description = "Address placed in the CAA iodef record."
  type        = string
  default     = ""
}
