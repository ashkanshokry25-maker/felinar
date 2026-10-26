locals {
  wildcard = "*.${var.sites_domain}"

  # Shell CSP (ARCHITECTURE.md section 13) plus frame-ancestors. Keep < 1,783 characters: CloudFront's limit for a CSP value in a response headers policy.
  shell_csp = join("; ", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' https: wss:",
    "img-src 'self' blob: data:",
    "frame-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ])

  # Default-deny powerful features on every hub origin; a site that needs one must be served from a hub that allows it.
  permissions_policy = join(", ", [
    "accelerometer=()", "autoplay=()", "bluetooth=()", "camera=()", "display-capture=()", "geolocation=()",
    "gyroscope=()", "hid=()", "magnetometer=()", "microphone=()", "payment=()", "serial=()", "usb=()", "xr-spatial-tracking=()",
  ])
}

# ---------------------------------------------------------------- origin: one private bucket holding the shell

resource "aws_s3_bucket" "shell" {
  bucket = var.bucket_name
}

resource "aws_s3_bucket_public_access_block" "shell" {
  bucket                  = aws_s3_bucket.shell.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "shell" {
  bucket = aws_s3_bucket.shell.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_cloudfront_origin_access_control" "shell" {
  name                              = "${var.name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_iam_policy_document" "shell" {
  statement {
    sid       = "CloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.shell.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.sites.arn]
    }
  }
  # Without s3:ListBucket, S3 answers 403 (not 404) for a missing key.
  statement {
    sid       = "CloudFrontList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.shell.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.sites.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "shell" {
  bucket = aws_s3_bucket.shell.id
  policy = data.aws_iam_policy_document.shell.json
}

# ---------------------------------------------------------------- TLS: ONE wildcard certificate (labels never appear in CT logs)

resource "aws_acm_certificate" "sites" {
  provider                  = aws.use1
  domain_name               = local.wildcard
  subject_alternative_names = [var.sites_domain]
  validation_method         = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for o in aws_acm_certificate.sites.domain_validation_options : o.domain_name => {
      name   = o.resource_record_name
      type   = o.resource_record_type
      record = o.resource_record_value
    }
  }
  allow_overwrite = true # wildcard and apex share one validation CNAME
  zone_id         = var.sites_zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 60
  records         = [each.value.record]
}

resource "aws_acm_certificate_validation" "sites" {
  provider                = aws.use1
  certificate_arn         = aws_acm_certificate.sites.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

# ---------------------------------------------------------------- edge policy: KeyValueStore denylist + viewer-request function

resource "aws_cloudfront_key_value_store" "denylist" {
  name    = "${var.name}-denylist"
  comment = "label -> reason code. Manage entries with denylist-sync.sh, not Terraform (keeps state small)."
}

resource "aws_cloudfront_function" "edge" {
  name                         = "${var.name}-edge"
  runtime                      = "cloudfront-js-2.0"
  comment                      = "label grammar, 451 denylist, status ping, navigation fallback"
  publish                      = true
  key_value_store_associations = [aws_cloudfront_key_value_store.denylist.arn]
  code = replace(
    replace(file("${path.module}/edge.js"), "__SITES_DOMAIN__", var.sites_domain),
    "__CONTROL_URL__", "https://${var.control_domain}"
  )
}

# ---------------------------------------------------------------- caching + headers

# Whole shell (ARCHITECTURE.md v0.2 section 3.1: /index.html, /404.html, /mw-sw.js, /_mw/*): short edge TTL ("purge the CDN on every deploy",
# section 7.1); no Host, cookie, header or query in the key, so every label shares one cached copy.
resource "aws_cloudfront_cache_policy" "shell" {
  name        = "${var.name}-shell"
  default_ttl = 300
  min_ttl     = 0
  max_ttl     = 3600
  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "shell" {
  name    = "${var.name}-shell-headers"
  comment = "Security headers for every hub origin"
  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = false # flip only after reading hstspreload.org warnings
      override                   = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
    content_security_policy {
      content_security_policy = local.shell_csp
      override                = true
    }
  }
  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = local.permissions_policy
      override = true
    }
    items {
      header   = "Origin-Agent-Cluster"
      value    = "?1"
      override = true
    }
    items {
      header   = "Cross-Origin-Opener-Policy"
      value    = "same-origin-allow-popups"
      override = true
    }
    items {
      header   = "X-Robots-Tag"
      value    = "noindex, nofollow"
      override = true
    }
  }
}

# ---------------------------------------------------------------- WAF (optional): per-IP rate limit; per-host limits are impossible for a shell-only hub

resource "aws_wafv2_web_acl" "hub" {
  count    = var.enable_waf ? 1 : 0
  provider = aws.use1
  name     = "${var.name}-acl"
  scope    = "CLOUDFRONT"
  default_action {
    allow {}
  }
  rule {
    name     = "ip-rate"
    priority = 1
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit                 = var.waf_ip_limit_per_5min
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name}-ip-rate"
      sampled_requests_enabled   = true
    }
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name}-acl"
    sampled_requests_enabled   = true
  }
}

# ---------------------------------------------------------------- distribution

resource "aws_cloudfront_distribution" "sites" {
  enabled         = true
  is_ipv6_enabled = true
  http_version    = "http2and3"
  comment         = "magnet-web hub sites domain (wildcard)"
  aliases         = [local.wildcard, var.sites_domain]
  price_class     = var.price_class
  web_acl_id      = var.enable_waf ? aws_wafv2_web_acl.hub[0].arn : null

  origin {
    domain_name              = aws_s3_bucket.shell.bucket_regional_domain_name
    origin_id                = "shell"
    origin_access_control_id = aws_cloudfront_origin_access_control.shell.id
  }

  # Navigations, /mw-sw.js and every other path: through the edge function (denylist is checked BEFORE the cache, so a denylisted
  # label also gets 451 + Clear-Site-Data for the browser's own SW update fetch).
  default_cache_behavior {
    target_origin_id           = "shell"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.shell.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.shell.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.edge.arn
    }
  }

  # The network-only status ping: generated by the function (never cached, never answered by the SW). Listed BEFORE /_mw/* (first match wins).
  ordered_cache_behavior {
    path_pattern               = "/_mw/hub/*"
    target_origin_id           = "shell"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.shell.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.shell.id
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.edge.arn
    }
  }

  # Loader assets (boot.js, loader.js, sdk.js, webtorrent.min.js, ...): the same bytes for every label, so no function per request.
  ordered_cache_behavior {
    path_pattern               = "/_mw/*"
    target_origin_id           = "shell"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.shell.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.shell.id
  }

  # Deliberately NO custom_error_response mapping 403/404 to /index.html: a 200 HTML body for a missing script poisons caches.

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.sites.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}

# ---------------------------------------------------------------- DNS

resource "aws_route53_record" "wildcard" {
  for_each = toset(["A", "AAAA"])
  zone_id  = var.sites_zone_id
  name     = local.wildcard
  type     = each.key
  alias {
    name                   = aws_cloudfront_distribution.sites.domain_name
    zone_id                = aws_cloudfront_distribution.sites.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "apex" {
  for_each = toset(["A", "AAAA"])
  zone_id  = var.sites_zone_id
  name     = var.sites_domain
  type     = each.key
  alias {
    name                   = aws_cloudfront_distribution.sites.domain_name
    zone_id                = aws_cloudfront_distribution.sites.hosted_zone_id
    evaluate_target_health = false
  }
}

# Only Amazon may issue for this domain (documented CAA identifier: amazon.com).
resource "aws_route53_record" "caa" {
  zone_id = var.sites_zone_id
  name    = var.sites_domain
  type    = "CAA"
  ttl     = 3600
  records = compact([
    "0 issue \"amazon.com\"",
    "0 issuewild \"amazon.com\"",
    var.abuse_mailbox != "" ? "0 iodef \"mailto:${var.abuse_mailbox}\"" : "",
  ])
}

# PSL authentication (RFC 8553 style): leave in place after the PR merges.
resource "aws_route53_record" "psl" {
  count   = var.psl_pr_url != "" ? 1 : 0
  zone_id = var.sites_zone_id
  name    = "_psl.${var.sites_domain}"
  type    = "TXT"
  ttl     = 3600
  records = [var.psl_pr_url]
}
