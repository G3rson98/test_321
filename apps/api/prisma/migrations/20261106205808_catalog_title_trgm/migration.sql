-- API-A (RF-CAT-02, ESP §17.4): búsqueda por texto con comodín inicial (ILIKE '%q%') sobre títulos de casos y tests.
-- B-tree no acelera ILIKE con comodín inicial; pg_trgm (extensión "trusted" de PostgreSQL ≥ 13) sí. Medición en
-- docs/decisiones.md (D-0xx búsqueda). Cambio aditivo.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "ix_automated_test_title_trgm" ON "automated_test" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "ix_testrail_case_title_trgm" ON "testrail_case" USING GIN ("title" gin_trgm_ops);
