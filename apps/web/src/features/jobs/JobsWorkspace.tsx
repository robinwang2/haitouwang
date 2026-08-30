'use client';

import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { Job, JobsCapabilities, JobsPageState, Score } from './contracts';
import { jobsMessages, type JobsCopy } from './messages';
import { mockJobs, mockScores } from './mock-api';
import {
  filterJobs,
  gateTone,
  inferJobSource,
  jobCanStartReview,
  matchBand,
  moveJobSelection,
  resolveJobsState,
  scoreDecisionLabel,
  validJobUrl,
  type MatchFilter,
  type RiskFilter,
} from './model';
import styles from './jobs.module.css';

type JobsWorkspaceProps = {
  state?: JobsPageState;
  capabilities?: JobsCapabilities;
  jobs?: Job[];
  scores?: Score[];
  copy?: JobsCopy;
  locale?: string;
  requestId?: string;
  onRetry?: () => void;
};

export function JobsWorkspace({
  state = 'ready',
  capabilities = { canView: true, canEdit: true },
  jobs = mockJobs,
  scores = mockScores,
  copy = jobsMessages.en,
  locale = 'en-US',
  requestId = 'req_jobs_mock_01',
  onRetry,
}: JobsWorkspaceProps) {
  const pageState = resolveJobsState(state, capabilities.canView);
  const [query, setQuery] = useState('');
  const [match, setMatch] = useState<MatchFilter>('all');
  const [risk, setRisk] = useState<RiskFilter>('all');
  const [selectedId, setSelectedId] = useState(jobs[0]?.id ?? '');
  const [importOpen, setImportOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const importButtonRef = useRef<HTMLButtonElement>(null);

  const visibleJobs = useMemo(
    () => filterJobs(jobs, scores, { query, match, risk }),
    [jobs, match, query, risk, scores],
  );
  const selectedJob = visibleJobs.find((job) => job.id === selectedId) ?? visibleJobs[0];
  const selectedScore = scores.find((score) => score.job_id === selectedJob?.id);
  const hasFilters = Boolean(query) || match !== 'all' || risk !== 'all';

  function clearFilters() {
    setQuery('');
    setMatch('all');
    setRisk('all');
  }

  function onListKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const index = Math.max(
      0,
      visibleJobs.findIndex((job) => job.id === selectedJob?.id),
    );
    const destination = moveJobSelection(index, visibleJobs.length, event.key);
    if (destination === null) return;
    event.preventDefault();
    setSelectedId(visibleJobs[destination].id);
    document
      .getElementById(`job-option-${visibleJobs[destination].id}`)
      ?.scrollIntoView({ block: 'nearest' });
  }

  if (pageState === 'loading') return <JobsLoading copy={copy} />;
  if (pageState === 'permission') return <JobsPermission copy={copy} />;
  if (pageState === 'error') {
    return (
      <main className={styles.shell}>
        <section className={styles.statePanel} role="alert">
          <span className={styles.stateIcon} aria-hidden="true">
            !
          </span>
          <div>
            <h1>{copy.errorTitle}</h1>
            <p>{copy.errorBody}</p>
            <code>
              {copy.requestId}: {requestId}
            </code>
          </div>
          <button className={styles.primaryButton} onClick={onRetry} type="button">
            {copy.retry}
          </button>
        </section>
      </main>
    );
  }
  if (pageState === 'empty' || jobs.length === 0) {
    return <JobsEmpty copy={copy} />;
  }

  return (
    <main className={styles.shell}>
      {pageState === 'paused' && (
        <aside className={styles.pauseBanner} role="status">
          <span aria-hidden="true">Ⅱ</span>
          <div>
            <strong>{copy.pausedTitle}</strong>
            <p>{copy.pausedBody}</p>
          </div>
        </aside>
      )}
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>{copy.eyebrow}</p>
          <h1>{copy.title}</h1>
          <p>{copy.description}</p>
        </div>
        <button
          className={styles.primaryButton}
          onClick={() => setImportOpen(true)}
          ref={importButtonRef}
          type="button"
        >
          <span aria-hidden="true">＋</span>
          {copy.import}
        </button>
      </header>

      <section aria-label="Job filters" className={styles.filters}>
        <label className={styles.searchField}>
          <span>{copy.searchLabel}</span>
          <div>
            <span aria-hidden="true">⌕</span>
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder={copy.searchPlaceholder}
              type="search"
              value={query}
            />
          </div>
        </label>
        <label>
          <span>{copy.matchLabel}</span>
          <select onChange={(event) => setMatch(event.target.value as MatchFilter)} value={match}>
            <option value="all">{copy.all}</option>
            <option value="high">{copy.highMatch}</option>
            <option value="medium">{copy.mediumMatch}</option>
            <option value="low">{copy.lowMatch}</option>
          </select>
        </label>
        <label>
          <span>{copy.riskLabel}</span>
          <select onChange={(event) => setRisk(event.target.value as RiskFilter)} value={risk}>
            <option value="all">{copy.all}</option>
            <option value="low">{copy.lowRisk}</option>
            <option value="medium">{copy.mediumRisk}</option>
            <option value="high">{copy.highRisk}</option>
          </select>
        </label>
        {hasFilters && (
          <button className={styles.clearButton} onClick={clearFilters} type="button">
            {copy.clear}
          </button>
        )}
      </section>

      <p aria-live="polite" className={styles.resultCount} role="status">
        <strong>{visibleJobs.length}</strong> {copy.results}
      </p>

      {visibleJobs.length === 0 ? (
        <section className={styles.filteredEmpty}>
          <span aria-hidden="true">⌕</span>
          <h2>{copy.filteredEmptyTitle}</h2>
          <p>{copy.filteredEmptyBody}</p>
          <button className={styles.secondaryButton} onClick={clearFilters} type="button">
            {copy.clear}
          </button>
        </section>
      ) : (
        <div className={styles.workspace}>
          <section aria-label={copy.title} className={styles.listPane}>
            <ul
              aria-activedescendant={selectedJob ? `job-option-${selectedJob.id}` : undefined}
              className={styles.jobList}
              onKeyDown={onListKeyDown}
              role="listbox"
              tabIndex={0}
            >
              {visibleJobs.map((job) => {
                const score = scores.find((item) => item.job_id === job.id);
                return (
                  <li
                    aria-label={`${job.title}, ${job.company}`}
                    aria-selected={job.id === selectedJob?.id}
                    className={styles.jobCard}
                    id={`job-option-${job.id}`}
                    key={job.id}
                    onClick={() => setSelectedId(job.id)}
                    role="option"
                  >
                    <div className={styles.jobTopline}>
                      <span className={styles.source}>{job.source.replace('_', ' ')}</span>
                      {score && (
                        <strong className={`${styles.score} ${styles[matchBand(score.total)]}`}>
                          {score.total}
                        </strong>
                      )}
                    </div>
                    <h2>{job.title}</h2>
                    <p className={styles.company}>{job.company}</p>
                    <p className={styles.location}>{job.location}</p>
                    <div className={styles.cardMeta}>
                      {score && <DecisionBadge copy={copy} score={score} />}
                      <span className={`${styles.riskBadge} ${styles[job.risk.level]}`}>
                        {copy.risk}: {job.risk.level}
                      </span>
                    </div>
                    <p className={styles.sourceCount}>
                      {job.source_refs.length} {copy.merged}
                    </p>
                  </li>
                );
              })}
            </ul>
          </section>
          {selectedJob && selectedScore && (
            <JobDetail
              canEdit={capabilities.canEdit}
              copy={copy}
              job={selectedJob}
              locale={locale}
              paused={pageState === 'paused'}
              score={selectedScore}
              onAnnouncement={setAnnouncement}
            />
          )}
        </div>
      )}
      {importOpen && (
        <ImportDialog
          copy={copy}
          onClose={() => {
            setImportOpen(false);
            requestAnimationFrame(() => importButtonRef.current?.focus());
          }}
          onImported={() => setAnnouncement(copy.importAccepted)}
        />
      )}
      <p className={styles.srOnly} aria-live="polite" role="status">
        {announcement}
      </p>
    </main>
  );
}

function JobDetail({
  canEdit,
  copy,
  job,
  locale,
  paused,
  score,
  onAnnouncement,
}: {
  canEdit: boolean;
  copy: JobsCopy;
  job: Job;
  locale: string;
  paused: boolean;
  score: Score;
  onAnnouncement: (message: string) => void;
}) {
  const allowed = jobCanStartReview(job, score, canEdit, paused);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
    new Date(job.created_at),
  );
  const strongest = [...score.dimensions].sort((a, b) => b.score - a.score).slice(0, 3);
  const gaps = [...score.dimensions].sort((a, b) => a.score - b.score).slice(0, 2);

  return (
    <article aria-labelledby="job-detail-title" className={styles.detailPane}>
      <header className={styles.detailHeader}>
        <p className={styles.eyebrow}>{copy.selected}</p>
        <h2 id="job-detail-title" tabIndex={-1}>
          {job.title}
        </h2>
        <p className={styles.detailCompany}>
          {job.company} <span>·</span> {job.location}
        </p>
        <div className={styles.detailScore}>
          <strong>{score.total}</strong>
          <span>
            /100
            <br />
            {
              copy[
                matchBand(score.total) === 'high'
                  ? 'highMatch'
                  : matchBand(score.total) === 'medium'
                    ? 'mediumMatch'
                    : 'lowMatch'
              ]
            }
          </span>
          <DecisionBadge copy={copy} score={score} />
        </div>
        <dl className={styles.summaryGrid}>
          <div>
            <dt>{copy.source}</dt>
            <dd>{job.source.replace('_', ' ')}</dd>
          </div>
          <div>
            <dt>{copy.posted}</dt>
            <dd>{date}</dd>
          </div>
          <div>
            <dt>{copy.risk}</dt>
            <dd>{job.risk.level}</dd>
          </div>
          <div>
            <dt>{copy.status}</dt>
            <dd>{job.status.replace('_', ' ')}</dd>
          </div>
        </dl>
      </header>

      <section className={styles.detailSection}>
        <h3>{copy.hardRules}</h3>
        <ul className={styles.gateGrid}>
          {score.hard_gates.map((gate) => (
            <li className={styles[gateTone(gate)]} key={gate.name}>
              <span aria-hidden="true">
                {gate.result === 'pass' ? '✓' : gate.result === 'block' ? '×' : '!'}
              </span>
              <div>
                <strong>{gate.name.replaceAll('_', ' ')}</strong>
                <small>{gate.result}</small>
              </div>
            </li>
          ))}
        </ul>
        {job.risk.reasons.length > 0 && (
          <ul className={styles.riskReasons}>
            {job.risk.reasons.map((reason) => (
              <li key={reason}>{reason.replaceAll('_', ' ')}</li>
            ))}
          </ul>
        )}
      </section>

      <div className={styles.explanationGrid}>
        <section className={styles.detailSection}>
          <h3>{copy.strengths}</h3>
          <ul>
            {strongest.map((dimension) => (
              <li key={dimension.name}>
                <strong>{dimension.name.replace('_', ' ')}</strong>
                <span>{dimension.score}%</span>
              </li>
            ))}
          </ul>
        </section>
        <section className={styles.detailSection}>
          <h3>{copy.gaps}</h3>
          <ul>
            {gaps.map((dimension) => (
              <li key={dimension.name}>
                <strong>{dimension.name.replace('_', ' ')}</strong>
                <span>{dimension.score}%</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className={styles.detailSection}>
        <h3>{copy.strategy}</h3>
        <ol className={styles.explanations}>
          {score.explanations.map((explanation) => (
            <li key={explanation}>{explanation}</li>
          ))}
        </ol>
      </section>

      <section className={styles.detailSection}>
        <h3>{copy.descriptionHeading}</h3>
        <p className={styles.contractNotice}>
          {copy.status}: <strong>{job.description_status}</strong>. {copy.descriptionUnavailable}
        </p>
      </section>

      <section className={styles.detailSection}>
        <h3>{copy.sourceHistory}</h3>
        <ul className={styles.sourceHistory}>
          {job.source_refs.map((source) => (
            <li key={`${source.type}-${source.reference}`}>
              <span>{source.type}</span>
              <code>{source.reference}</code>
            </li>
          ))}
        </ul>
      </section>

      {!canEdit && <p className={styles.readonlyNote}>{copy.readOnly}</p>}
      <footer className={styles.detailActions}>
        <div>
          <button
            className={styles.ghostButton}
            disabled={!canEdit}
            onClick={() => onAnnouncement(`${copy.save}: ${job.title}`)}
            type="button"
          >
            {copy.save}
          </button>
          <button className={styles.ghostButton} disabled={!canEdit} type="button">
            {copy.ignore}
          </button>
          <a href={job.canonical_url} rel="noopener noreferrer" target="_blank">
            {copy.openOriginal}
            <span aria-hidden="true"> ↗</span>
          </a>
        </div>
        {allowed ? (
          <button className={styles.primaryButton} type="button">
            {copy.addToReview}
          </button>
        ) : (
          <button className={styles.warningButton} disabled={!canEdit || paused} type="button">
            {copy.createManualReview}
          </button>
        )}
      </footer>
    </article>
  );
}

function DecisionBadge({ copy, score }: { copy: JobsCopy; score: Score }) {
  const decision = scoreDecisionLabel(score.decision);
  const label =
    decision === 'eligible'
      ? copy.eligible
      : decision === 'blocked'
        ? copy.blocked
        : decision === 'manual'
          ? copy.manualReview
          : copy.unknownStatus;
  return (
    <span className={`${styles.decision} ${styles[decision]}`}>
      <span aria-hidden="true">{decision === 'eligible' ? '✓' : '!'}</span>
      {label}
    </span>
  );
}

function ImportDialog({
  copy,
  onClose,
  onImported,
}: {
  copy: JobsCopy;
  onClose: () => void;
  onImported: () => void;
}) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState(false);
  const [source, setSource] = useState('manual_url');
  const cancelRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validJobUrl(url)) {
      setError(true);
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    onImported();
    onClose();
  }

  return (
    <div className={styles.dialogBackdrop}>
      <div
        aria-describedby="import-help"
        aria-labelledby="import-title"
        aria-modal="true"
        className={styles.dialog}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
        role="dialog"
      >
        <span className={styles.dialogMark} aria-hidden="true">
          ↗
        </span>
        <h2 id="import-title">{copy.importTitle}</h2>
        <p id="import-help">{copy.importHelp}</p>
        <form noValidate onSubmit={submit}>
          {error && (
            <div className={styles.dialogError} ref={errorRef} role="alert" tabIndex={-1}>
              {copy.urlError}
            </div>
          )}
          <label>
            <span>
              {copy.urlLabel} · {copy.required}
            </span>
            <input
              aria-describedby={error ? 'job-url-error' : 'import-help'}
              aria-invalid={error}
              autoComplete="url"
              onChange={(event) => {
                const next = event.target.value;
                setUrl(next);
                setError(false);
                if (validJobUrl(next)) setSource(inferJobSource(next));
              }}
              placeholder="https://…"
              type="url"
              value={url}
            />
            {error && <small id="job-url-error">{copy.urlError}</small>}
          </label>
          <label>
            <span>{copy.sourceLabel}</span>
            <select onChange={(event) => setSource(event.target.value)} value={source}>
              <option value="greenhouse">Greenhouse</option>
              <option value="lever">Lever</option>
              <option value="company_careers">Company Careers</option>
              <option value="manual_url">Manual URL</option>
            </select>
          </label>
          <div className={styles.dialogActions}>
            <button
              className={styles.secondaryButton}
              onClick={onClose}
              ref={cancelRef}
              type="button"
            >
              {copy.cancel}
            </button>
            <button className={styles.primaryButton} type="submit">
              {copy.importAction}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function JobsLoading({ copy }: { copy: JobsCopy }) {
  return (
    <main aria-busy="true" aria-label={copy.loading} className={styles.shell}>
      <span className={styles.srOnly}>{copy.loading}</span>
      <div className={styles.skeletonHero}>
        <i />
        <i />
        <i />
      </div>
      <div className={styles.skeletonFilters}>
        <i />
        <i />
        <i />
      </div>
      <div className={styles.skeletonWorkspace}>
        <div>
          <i />
          <i />
          <i />
        </div>
        <div>
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
    </main>
  );
}

function JobsEmpty({ copy }: { copy: JobsCopy }) {
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  function close() {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }
  return (
    <main className={styles.shell}>
      <section className={styles.statePanel}>
        <span className={styles.emptyIcon} aria-hidden="true">
          ＋
        </span>
        <div>
          <p className={styles.eyebrow}>{copy.eyebrow}</p>
          <h1>{copy.emptyTitle}</h1>
          <p>{copy.emptyBody}</p>
        </div>
        <button
          className={styles.primaryButton}
          onClick={() => setOpen(true)}
          ref={triggerRef}
          type="button"
        >
          {copy.import}
        </button>
      </section>
      {open && (
        <ImportDialog
          copy={copy}
          onClose={close}
          onImported={() => setAnnouncement(copy.importAccepted)}
        />
      )}
      <p className={styles.srOnly} aria-live="polite" role="status">
        {announcement}
      </p>
    </main>
  );
}

function JobsPermission({ copy }: { copy: JobsCopy }) {
  return (
    <main className={styles.shell}>
      <section className={styles.statePanel}>
        <span className={styles.stateIcon} aria-hidden="true">
          ×
        </span>
        <div>
          <h1>{copy.permissionTitle}</h1>
          <p>{copy.permissionBody}</p>
        </div>
        <a className={styles.secondaryButton} href="/">
          {copy.back}
        </a>
      </section>
    </main>
  );
}
