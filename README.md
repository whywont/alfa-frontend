# Alfa

Protein structure prediction for people who don't want to learn Slurm. Paste
sequences, come back later, get structures with confidence you can read.

The GPU lives in borrowed, ephemeral compute (a free Colab or molab session).
Workers there pull jobs from this app and hold them with expiring leases, so a
session dying mid-job just means the job runs again on the next one. See
[docs/architecture.md](docs/architecture.md); progress is in
[docs/plan.md](docs/plan.md).

Early days: the queue, worker protocol, and a real fold end to end work; the
real UI, auth, and deployment are next.

## Run it locally

Needs Node 22+, pnpm, and Python 3.10+.

```sh
pnpm install
cp .env.example .env.local
pnpm worker:token "my laptop" local   # prints ALFA_WORKER_TOKEN=...; run before `pnpm dev`
pnpm dev                              # http://localhost:3000
```

With no `DATABASE_URL`, the app uses an embedded Postgres (PGlite) in
`.data/pglite`, and stores files in `.data/storage`. PGlite is single-process,
so mint tokens while the dev server is stopped.

Submit a sequence at http://localhost:3000, then run a worker:

```sh
cd worker
ALFA_WORKER_TOKEN=... python3 -m alfa_worker --server http://localhost:3000 --runner esmatlas
```

`--runner esmatlas` folds with ESMFold through Meta's public ESM Atlas API, so
it works on a laptop with no GPU. It sends the sequence to Meta; don't use it
for anything unpublished. On a machine with a CUDA GPU, use
`--runner esmfold` (needs `pip install './worker[esmfold]'`).

## Run a worker on Colab

Open [`worker/colab_worker.ipynb`](worker/colab_worker.ipynb) in Colab, pick a
T4 runtime, add `ALFA_SERVER` and `ALFA_WORKER_TOKEN` as notebook secrets, and
run all. The server has to be reachable from the internet (deployed, or
tunneled) for this to work.

## Deploy

Production is Vercel (app) + Neon (Postgres) + Cloudflare R2 (files), all
declared in [`infra/`](infra/) with [OpenTofu](https://opentofu.org).

**One-time, by hand** (the credentials OpenTofu uses to create everything else):

| Env var | Where to get it |
|---|---|
| `NEON_API_KEY` | Neon console → Account settings → API keys |
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create token. Needs **Account API Tokens: Edit** and **Workers R2 Storage: Edit** on your account. |
| `VERCEL_API_TOKEN` | Vercel → Account settings → Tokens |

Also install the Vercel GitHub app on the repo (Vercel dashboard → Add New
Project → Import from GitHub is enough to grant access; you can cancel the
import).

```sh
brew install opentofu
cd infra
cp terraform.tfvars.example terraform.tfvars   # fill in cloudflare_account_id
export NEON_API_KEY=... CLOUDFLARE_API_TOKEN=... VERCEL_API_TOKEN=...
tofu init
tofu plan     # read it
tofu apply
```

Then push to `main`; Vercel deploys on every push. Mint a worker token
against the production database:

```sh
DATABASE_URL="$(cd infra && tofu output -raw database_url)" pnpm worker:token "my colab" colab
```

State is kept locally in `infra/terraform.tfstate` (gitignored). It contains
secrets, so don't share it; moving it to remote storage is on the plan.

## Tests

```sh
pnpm test        # queue state machine against an in-memory Postgres
pnpm typecheck
```
