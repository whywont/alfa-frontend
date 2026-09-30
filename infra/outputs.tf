output "app_project" {
  description = "Vercel project name."
  value       = vercel_project.app.name
}

output "database_url" {
  description = "Direct (unpooled) connection string, for scripts like `pnpm worker:token`."
  value       = neon_project.db.connection_uri
  sensitive   = true
}

output "artifacts_bucket" {
  value = cloudflare_r2_bucket.artifacts.name
}
