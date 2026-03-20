-- GHF Oracle — Supabase schema
-- Run once in the Supabase SQL Editor

create extension if not exists vector;

-- One row per source file in Google Drive
create table if not exists ghf_documents (
  id            uuid primary key default gen_random_uuid(),
  drive_file_id text not null unique,
  file_name     text not null,
  mime_type     text not null,
  folder_label  text,
  modified_at   timestamptz not null,
  ingested_at   timestamptz not null default now(),
  chunk_count   integer not null default 0
);

-- One row per ~500-token chunk
create table if not exists ghf_chunks (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references ghf_documents(id) on delete cascade,
  drive_file_id text not null,
  chunk_index   integer not null,
  content       text not null,
  token_count   integer not null,
  embedding     vector(1536),
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  unique(drive_file_id, chunk_index)
);

-- Vector similarity index
create index if not exists ghf_chunks_embedding_idx
  on ghf_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Metadata filter index
create index if not exists ghf_chunks_metadata_idx
  on ghf_chunks using gin(metadata);

-- Match function called by the Cloudflare Worker
create or replace function match_ghf_chunks(
  query_embedding vector(1536),
  match_count     int     default 10,
  filter_label    text    default null
)
returns table (
  id            uuid,
  drive_file_id text,
  content       text,
  metadata      jsonb,
  similarity    float
)
language plpgsql
as $$
begin
  return query
  select
    c.id,
    c.drive_file_id,
    c.content,
    c.metadata,
    1 - (c.embedding <=> query_embedding) as similarity
  from ghf_chunks c
  join ghf_documents d on d.drive_file_id = c.drive_file_id
  where c.embedding is not null
    and (filter_label is null or d.folder_label = filter_label)
  order by c.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- RLS (service role key bypasses these automatically)
alter table ghf_documents enable row level security;
alter table ghf_chunks enable row level security;
