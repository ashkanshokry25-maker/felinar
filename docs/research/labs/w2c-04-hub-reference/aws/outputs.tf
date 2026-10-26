output "distribution_id" {
  value = aws_cloudfront_distribution.sites.id
}

output "distribution_domain" {
  value = aws_cloudfront_distribution.sites.domain_name
}

output "bucket" {
  value = aws_s3_bucket.shell.bucket
}

output "denylist_kvs_arn" {
  value = aws_cloudfront_key_value_store.denylist.arn
}

output "certificate_arn" {
  value = aws_acm_certificate.sites.arn
}
