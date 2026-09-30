variable "name" {
  description = "Base name for every resource."
  type        = string
  default     = "alfa"
}

variable "github_repo" {
  description = "GitHub repo Vercel deploys from, as owner/name."
  type        = string
  default     = "whywont/alfa-frontend"
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID (dashboard → any domain or R2 page → right sidebar)."
  type        = string
}

variable "neon_org_id" {
  description = "Neon organization ID. Needed if your Neon account belongs to an org."
  type        = string
  default     = null
}

variable "neon_region" {
  description = "Neon region. us-west-2 (Oregon) is closest to San Diego among Neon's AWS regions."
  type        = string
  default     = "aws-us-west-2"
}

variable "vercel_team" {
  description = "Vercel team slug or ID. Leave null for a personal account."
  type        = string
  default     = null
}
