# Knowledge retrieval evaluation

- Fixture: `fixtures/retrieval-golden-set.json`
- Metric: Recall@10
- Approved threshold: `>= 0.80`
- Deterministic corpus: 20 confirmed facts, including English and Chinese queries
- Verified result: `5/5` relevant facts recalled, `Recall@10 = 1.00`
- Reproduction: run the repository unit-test command and inspect
  `knowledge.recall.unit.test.ts`

The executable test calculates the metric from the fixture on every run. The
report intentionally records no user fact text or external-provider output.
