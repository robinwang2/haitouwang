CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  canonical_url text NOT NULL,
  source text NOT NULL,
  source_refs jsonb NOT NULL,
  title text NOT NULL,
  company text NOT NULL,
  location text NOT NULL,
  employment_type text NOT NULL,
  salary jsonb,
  description_status text NOT NULL,
  risk jsonb NOT NULL,
  status text NOT NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX jobs_status_idx ON jobs (status);
CREATE INDEX jobs_source_idx ON jobs (source);
CREATE INDEX jobs_employment_type_idx ON jobs (employment_type);
CREATE INDEX jobs_company_idx ON jobs (company);
