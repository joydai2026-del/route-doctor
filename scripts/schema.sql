-- Route Doctor: corpus table + match function (approach from supabase-community/nextjs-openai-doc-search, Apache-2.0)
create extension if not exists vector;
create table if not exists rd_chunks (
  id bigserial primary key,
  source_type text not null check (source_type in ('docs','issue')),
  url text not null,
  title text not null,
  content text not null,
  embedding vector(1024) not null
);
create index if not exists rd_chunks_embedding_idx on rd_chunks using hnsw (embedding vector_cosine_ops);
alter table rd_chunks enable row level security;
create table if not exists rd_uncovered (
  id bigserial primary key,
  created_at timestamptz default now(),
  question text not null,
  model text
);
alter table rd_uncovered enable row level security;
create or replace function rd_match_chunks(query_embedding vector(1024), match_count int default 20)
returns table (id bigint, source_type text, url text, title text, content text, similarity float)
language sql stable as $$
  select id, source_type, url, title, content, 1 - (embedding <=> query_embedding) as similarity
  from rd_chunks order by embedding <=> query_embedding limit match_count;
$$;
