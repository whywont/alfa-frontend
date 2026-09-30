-- Job queue, attempts, and the artifacts each attempt produced.
--
-- A job is the user's request ("fold these chains this way"). An attempt is
-- one worker's lease on that job. A job whose GPU session dies gets a new
-- attempt; the old one is kept, so every artifact traces back to exactly the
-- worker, backend, and code version that produced it.

create table jobs (
  id                 text primary key,
  owner_id           text not null,
  batch_id           text,
  name               text not null,
  model              text not null,                 -- 'esmfold' | 'colabfold'
  mode               text not null check (mode in ('monomer', 'complex')),
  preset             text not null check (preset in ('fast', 'thorough')),
  chains             jsonb not null,                -- [{ "id": "A", "sequence": "MKT..." }]
  total_residues     integer not null,
  input_hash         text not null,                 -- sha256 of model + preset + chains, for dedupe
  params             jsonb not null default '{}',
  state              text not null check (state in
                       ('queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled')),
  priority           integer not null default 0,
  attempts           integer not null default 0,
  max_attempts       integer not null default 5,
  run_after          timestamptz not null,
  current_attempt_id text,
  error_code         text,
  error_message      text,
  mean_plddt         real,
  ptm                real,
  iptm               real,
  created_at         timestamptz not null,
  updated_at         timestamptz not null,
  started_at         timestamptz,
  finished_at        timestamptz
);

create index jobs_claimable on jobs (priority desc, created_at) where state = 'queued';
create index jobs_owner on jobs (owner_id, created_at desc);
create index jobs_input_hash on jobs (input_hash);

create table job_attempts (
  id               text primary key,
  job_id           text not null references jobs (id) on delete cascade,
  attempt_no       integer not null,
  worker_id        text not null,
  backend          text not null,                   -- 'colab' | 'molab' | 'local' | 'slurm' | ...
  lease_token      text not null,
  lease_expires_at timestamptz not null,
  state            text not null check (state in
                     ('running', 'succeeded', 'failed', 'expired', 'cancelled')),
  progress         jsonb,
  worker_info      jsonb,                           -- gpu, worker version, model weights, python/torch versions
  error_code       text,
  error_message    text,
  started_at       timestamptz not null,
  ended_at         timestamptz,
  unique (job_id, attempt_no)
);

create index job_attempts_running on job_attempts (lease_expires_at) where state = 'running';

-- Every state change, with a reason. This is the job's history for the UI and for provenance.
create table job_events (
  id         bigserial primary key,
  job_id     text not null references jobs (id) on delete cascade,
  attempt_id text,
  at         timestamptz not null,
  from_state text,
  to_state   text not null,
  reason     text not null
);

create index job_events_job on job_events (job_id, id);

create table job_logs (
  id         bigserial primary key,
  job_id     text not null references jobs (id) on delete cascade,
  attempt_id text not null,
  at         timestamptz not null,
  line       text not null
);

create index job_logs_job on job_logs (job_id, id);

create table artifacts (
  id           text primary key,
  job_id       text not null references jobs (id) on delete cascade,
  attempt_id   text not null references job_attempts (id) on delete cascade,
  name         text not null,                       -- 'model_1.pdb', 'scores_1.json', ...
  kind         text not null check (kind in ('structure', 'scores', 'pae', 'msa', 'log', 'other')),
  rank         integer,
  storage_key  text not null,
  content_type text not null,
  bytes        bigint not null,
  sha256       text not null,
  created_at   timestamptz not null,
  unique (attempt_id, name)
);

create table workers (
  id           text primary key,
  label        text not null,
  backend      text not null,
  token_hash   text not null unique,
  created_at   timestamptz not null,
  last_seen_at timestamptz,
  info         jsonb,
  revoked_at   timestamptz
);
