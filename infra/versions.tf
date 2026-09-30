terraform {
  required_version = ">= 1.8"

  required_providers {
    neon = {
      source  = "kislerdm/neon" # community provider; Neon doesn't publish an official one
      version = "~> 0.18"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.26"
    }
    vercel = {
      source  = "vercel/vercel"
      version = "~> 5.17"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }
}

# Credentials come from the environment, never from files in this repo:
#   NEON_API_KEY, CLOUDFLARE_API_TOKEN, VERCEL_API_TOKEN
provider "neon" {}
provider "cloudflare" {}
provider "vercel" {
  team = var.vercel_team
}
