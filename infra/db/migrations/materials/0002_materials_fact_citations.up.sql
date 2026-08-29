CREATE TABLE materials_fact_citations (
  id uuid PRIMARY KEY,
  material_id uuid NOT NULL,
  material_version integer NOT NULL,
  fact_id uuid NOT NULL,
  fact_version integer NOT NULL,
  claim_path text NOT NULL,
  user_id uuid NOT NULL,
  CONSTRAINT materials_fact_citations_material_fk
    FOREIGN KEY (material_id, material_version)
    REFERENCES materials_versions (material_id, version)
    ON DELETE CASCADE,
  CONSTRAINT materials_fact_citations_fact_fk
    FOREIGN KEY (fact_id, fact_version)
    REFERENCES profile_fact_versions (resource_id, version)
);

CREATE INDEX materials_fact_citations_user_id_idx
  ON materials_fact_citations (user_id, material_id, material_version);
