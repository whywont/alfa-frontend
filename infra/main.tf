# ---------------------------------------------------------------------------
# Database: Neon Postgres. Holds the queue, provenance, and artifact index.
# ---------------------------------------------------------------------------

resource "neon_project" "db" {
  name       = var.name
  org_id     = var.neon_org_id
  region_id  = var.neon_region
  pg_version = 17

  branch {
    name          = "main"
    database_name = var.name
    role_name     = "${var.name}_app"
  }

  # The queue's history lives here. Deleting it is never what a plan should do.
  lifecycle {
    prevent_destroy = true
  }
}

# ---------------------------------------------------------------------------
# File storage: Cloudflare R2. Structures, scores, and PAE matrices.
# R2 charges nothing for downloads, which matters when people pull zips of
# a hundred structures.
# ---------------------------------------------------------------------------

resource "cloudflare_r2_bucket" "artifacts" {
  account_id = var.cloudflare_account_id
  name       = "${var.name}-artifacts"
  location   = "wnam" # western North America

  lifecycle {
    prevent_destroy = true
  }
}

# Housekeeping only. Real retention is the app's job, because only the app
# knows which files a job still points to; a bucket rule that deleted old
# objects would leave the database referring to files that no longer exist.
resource "cloudflare_r2_bucket_lifecycle" "artifacts" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.artifacts.name

  rules = [{
    id      = "abort-stale-uploads"
    enabled = true
    conditions = {
      prefix = ""
    }
    abort_multipart_uploads_transition = {
      condition = { type = "Age", max_age = 86400 }
    }
  }]
}

# A credential that can read and write objects in this one bucket and do
# nothing else. It's owned by the account, not by a person, so it survives
# whoever set it up leaving.
data "cloudflare_account_api_token_permission_groups_list" "r2_write" {
  account_id = var.cloudflare_account_id
  name       = "Workers%20R2%20Storage%20Bucket%20Item%20Write"
}

resource "cloudflare_account_token" "r2" {
  account_id = var.cloudflare_account_id
  name       = "${var.name}-app-r2"

  policies = [{
    effect            = "allow"
    permission_groups = [{ id = data.cloudflare_account_api_token_permission_groups_list.r2_write.result[0].id }]
    resources = jsonencode({
      "com.cloudflare.edge.r2.bucket.${var.cloudflare_account_id}_default_${cloudflare_r2_bucket.artifacts.name}" = "*"
    })
  }]
}

locals {
  # R2 derives S3-style keys from an API token: the key ID is the token's ID,
  # and the secret is the SHA-256 of its value.
  r2_access_key_id     = cloudflare_account_token.r2.id
  r2_secret_access_key = sha256(cloudflare_account_token.r2.value)
  r2_endpoint          = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
}

# ---------------------------------------------------------------------------
# Web app: Vercel, deploying from GitHub on every push to main.
# ---------------------------------------------------------------------------

resource "vercel_project" "app" {
  name      = var.name
  framework = "nextjs"

  git_repository = {
    type              = "github"
    repo              = var.github_repo
    production_branch = "main"
  }
}

resource "random_password" "cron_secret" {
  length  = 40
  special = false
}

locals {
  app_env = {
    # Pooled connection: serverless functions open many short connections.
    DATABASE_URL         = neon_project.db.connection_uri_pooler
    S3_ENDPOINT          = local.r2_endpoint
    S3_BUCKET            = cloudflare_r2_bucket.artifacts.name
    S3_ACCESS_KEY_ID     = local.r2_access_key_id
    S3_SECRET_ACCESS_KEY = local.r2_secret_access_key
    CRON_SECRET          = random_password.cron_secret.result
  }
}

resource "vercel_project_environment_variable" "app" {
  for_each = local.app_env

  project_id = vercel_project.app.id
  key        = each.key
  value      = each.value
  target     = ["production", "preview"]
  sensitive  = true
}
