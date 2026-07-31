'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Application, DashboardCapabilities, DashboardPageState, Task } from './contracts';
import { dashboardMessages, type DashboardCopy } from './messages';
import { mockAgent, mockApplications, mockTasks } from './mock-api';
import {
  affectedTaskCount,
  agentSafety,
  AUTOMATIC_SUBMISSION_ENABLED,
  buildTodos,
  isVerifiedSubmission,
  resolveDashboardState,
  type DashboardTodo,
} from './model';
import styles from './dashboard.module.css';

type DashboardProps = {
  state?: DashboardPageState;
  capabilities?: DashboardCapabilities;
  agent?: Agent;
  applications?: Application[];
  tasks?: Task[];
  copy?: DashboardCopy;
  locale?: string;
  requestId?: string;
  onRetry?: () => void;
};

export function Dashboard({
  state = 'ready',
  capabilities = { canView: true, canOperateAgent: true },
  agent = mockAgent,
  applications = mockApplications,
  tasks = mockTasks,
  copy = dashboardMessages.en,
  locale = 'en-US',
  requestId = 'req_dashboard_mock_01',
  onRetry,
}: DashboardProps) {
  const pageState = resolveDashboardState(state, capabilities.canView);
  const [paused, setPaused] = useState(pageState === 'paused');
  const [dialog, setDialog] = useState<'pause' | 'resume' | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const switchRef = useRef<HTMLButtonElement>(null);
  const visibleApplications = pageState === 'empty' ? [] : applications;
  const todos = useMemo(() => buildTodos(visibleApplications, tasks), [tasks, visibleApplications]);
  const safety = agentSafety(agent);
  const visibleTodos = todos.slice(0, 4);
  const verifiedSubmissions = visibleApplications.filter(isVerifiedSubmission).length;

  if (pageState === 'loading') return <DashboardLoading copy={copy} />;
  if (pageState === 'permission') return <DashboardPermission copy={copy} />;
  if (pageState === 'error') {
    return (
      <main className={styles.shell}>
        <section className={styles.statePanel} role="alert">
          <span className={styles.errorMark} aria-hidden="true">!</span>
          <div><h1>{copy.errorTitle}</h1><p>{copy.errorBody}</p><code>{copy.requestId}: {requestId}</code></div>
          <button className={styles.primaryButton} onClick={onRetry} type="button">{copy.retry}</button>
        </section>
      </main>
    );
  }

  const effectivePaused = paused || safety !== 'online';

  return (
    <main className={styles.shell}>
      {effectivePaused && (
        <aside className={`${styles.globalBand} ${safety === 'unknown' ? styles.unknownBand : ''}`} role="status">
          <span aria-hidden="true">{safety === 'unknown' ? '?' : 'Ⅱ'}</span>
          <div>
            <strong>{safety === 'unknown' ? copy.unknown : copy.paused}</strong>
            <p>
              {safety === 'offline' ? copy.agentOffline : paused ? copy.confirmPauseBody : copy.errorBody}
              {' · '}{affectedTaskCount(tasks)} {copy.affected}
            </p>
          </div>
          <a href="/connections">{copy.statusDetail}<span aria-hidden="true"> →</span></a>
        </aside>
      )}

      <header className={styles.hero}>
        <div><p className={styles.eyebrow}>{copy.eyebrow}</p><h1>{copy.greeting}</h1><p>{copy.description}</p></div>
        <div className={styles.heroActions}>
          {visibleTodos.length > 0 && <a className={styles.primaryButton} href={`#todo-${visibleTodos[0].id}`}>{copy.nextTask}</a>}
          <a className={styles.secondaryButton} href="/jobs?import=true">{copy.importJob}</a>
        </div>
      </header>

      <section aria-labelledby="safety-heading" className={styles.safetyCard}>
        <div className={styles.safetyCopy}>
          <p className={styles.sectionEyebrow}>{copy.safetyTitle}</p>
          <h2 id="safety-heading">{effectivePaused ? copy.paused : copy.assisted}</h2>
          <p className={`${styles.statusLine} ${safety === 'online' ? styles.online : styles.offline}`}>
            <span aria-hidden="true" />
            {safety === 'online' ? copy.agentOnline : safety === 'offline' ? copy.agentOffline : copy.unknown}
            {agent.last_seen_at && <> · {copy.heartbeat} {formatRelative(agent.last_seen_at, locale)}</>}
          </p>
        </div>
        <div className={styles.safetyMetric}>
          <span>{copy.affected}</span><strong>{affectedTaskCount(tasks)}</strong>
        </div>
        <div className={styles.switches}>
          <div className={styles.switchRow}>
            <div><strong>{copy.safetyTitle}</strong><small>{effectivePaused ? copy.paused : copy.assisted}</small></div>
            <button
              aria-checked={!effectivePaused}
              aria-label={effectivePaused ? copy.resumeAll : copy.pauseAll}
              className={styles.switch}
              disabled={!capabilities.canOperateAgent || safety !== 'online'}
              onClick={() => setDialog(effectivePaused ? 'resume' : 'pause')}
              ref={switchRef}
              role="switch"
              type="button"
            ><span /></button>
          </div>
          <div className={styles.switchRow}>
            <div><strong>{copy.automaticSubmit}</strong><small>{copy.permanentlyOff}</small></div>
            <button aria-checked={AUTOMATIC_SUBMISSION_ENABLED} aria-label={`${copy.automaticSubmit}: ${copy.permanentlyOff}`} className={styles.switch} disabled role="switch" type="button"><span /></button>
          </div>
          {!capabilities.canOperateAgent && <p className={styles.readonlyNote}>{copy.readOnly}</p>}
        </div>
      </section>

      <div className={styles.mainGrid}>
        <section aria-labelledby="todo-heading" className={styles.todoSection}>
          <div className={styles.sectionHeader}>
            <div><p className={styles.sectionEyebrow}>{copy.needsAction}</p><h2 id="todo-heading">{copy.todoHeading}</h2><p>{copy.todoDescription}</p></div>
          </div>
          {visibleTodos.length > 0 ? (
            <ol className={styles.todoList}>
              {visibleTodos.map((todo, index) => <TodoCard copy={copy} index={index + 1} key={todo.id} locale={locale} todo={todo} />)}
            </ol>
          ) : (
            <div className={styles.inlineEmpty}>
              <span aria-hidden="true">✓</span>
              <h3>{pageState === 'empty' ? copy.emptyTitle : copy.noTodoTitle}</h3>
              <p>{pageState === 'empty' ? copy.emptyBody : copy.noTodoBody}</p>
              <a href="/jobs">{pageState === 'empty' ? copy.importJob : copy.open}</a>
            </div>
          )}
        </section>

        <aside className={styles.sidebar}>
          <section aria-labelledby="today-heading" className={styles.summaryCard}>
            <div className={styles.sectionHeader}><div><p className={styles.sectionEyebrow}>{copy.dayRange}</p><h2 id="today-heading">{copy.todayHeading}</h2></div></div>
            <dl className={styles.statsGrid}>
              <Stat href="/jobs?created=today" label={copy.discovered} value={pageState === 'empty' ? 0 : 12} />
              <Stat href="/jobs?match=high" label={copy.highMatch} value={pageState === 'empty' ? 0 : 5} />
              <Stat href="/jobs?decision=blocked" label={copy.blocked} value={pageState === 'empty' ? 0 : 3} />
              <Stat href="/applications?status=submitted" label={copy.submitted} value={pageState === 'empty' ? 0 : verifiedSubmissions} />
            </dl>
          </section>

          <section aria-labelledby="activity-heading" className={styles.activityCard}>
            <div className={styles.sectionHeader}>
              <div><p className={styles.sectionEyebrow}>{copy.auditTrail}</p><h2 id="activity-heading">{copy.activityHeading}</h2></div>
              <a href="/activity">{copy.viewAll}</a>
            </div>
            <ol className={styles.timeline}>
              {visibleApplications.slice(0, 4).map((application) => (
                <li key={application.id}>
                  <span className={styles.timelineMark} aria-hidden="true" />
                  <div><strong>{application.status.replaceAll('_', ' ')}</strong><p>{copy.applicationLabel} {application.id.slice(-4)}</p><time dateTime={application.updated_at}>{formatRelative(application.updated_at, locale)}</time></div>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>

      {dialog && (
        <SafetyDialog
          copy={copy}
          mode={dialog}
          onCancel={() => {
            setDialog(null);
            requestAnimationFrame(() => switchRef.current?.focus());
          }}
          onConfirm={() => {
            setPaused(dialog === 'pause');
            setDialog(null);
            setAnnouncement(copy.auditRecorded);
            requestAnimationFrame(() => switchRef.current?.focus());
          }}
        />
      )}
      <p className={styles.srOnly} aria-live="polite" role="status">{announcement}</p>
    </main>
  );
}

function TodoCard({ copy, index, locale, todo }: { copy: DashboardCopy; index: number; locale: string; todo: DashboardTodo }) {
  const labels = { review: copy.review, confirm: copy.confirm, manual: copy.manual, uncertain: copy.uncertain };
  return (
    <li className={`${styles.todoCard} ${styles[todo.kind]}`} id={`todo-${todo.id}`}>
      <span className={styles.todoIndex} aria-hidden="true">{String(index).padStart(2, '0')}</span>
      <div className={styles.todoText}>
        <span>{labels[todo.kind]}</span>
        <h3>{todo.title}</h3>
        <p>{todo.detail}</p>
      </div>
      <time dateTime={todo.updatedAt}>{formatRelative(todo.updatedAt, locale)}</time>
      <a aria-label={`${copy.open}: ${todo.title}`} href={`/applications/${todo.id}`}>{copy.open}<span aria-hidden="true"> →</span></a>
    </li>
  );
}

function Stat({ href, label, value }: { href: string; label: string; value: number }) {
  return <div><dt><a href={href}>{label}</a></dt><dd>{value}</dd></div>;
}

function SafetyDialog({
  copy,
  mode,
  onCancel,
  onConfirm,
}: {
  copy: DashboardCopy;
  mode: 'pause' | 'resume';
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  const isPause = mode === 'pause';
  return (
    <div className={styles.dialogBackdrop}>
      <div
        aria-describedby="safety-dialog-body"
        aria-labelledby="safety-dialog-title"
        aria-modal="true"
        className={styles.dialog}
        onKeyDown={(event) => { if (event.key === 'Escape') onCancel(); }}
        role="dialog"
      >
        <span className={styles.dialogMark} aria-hidden="true">{isPause ? 'Ⅱ' : '▶'}</span>
        <h2 id="safety-dialog-title">{isPause ? copy.confirmPauseTitle : copy.confirmResumeTitle}</h2>
        <p id="safety-dialog-body">{isPause ? copy.confirmPauseBody : copy.confirmResumeBody}</p>
        {!isPause && (
          <div className={styles.submitGuard}>
            <span aria-hidden="true">×</span><strong>{copy.automaticSubmit}</strong><small>{copy.permanentlyOff}</small>
          </div>
        )}
        <div className={styles.dialogActions}>
          <button className={styles.secondaryButton} onClick={onCancel} ref={cancelRef} type="button">{copy.cancel}</button>
          <button className={isPause ? styles.dangerButton : styles.primaryButton} onClick={onConfirm} type="button">
            {isPause ? copy.confirmPause : copy.confirmResume}
          </button>
        </div>
      </div>
    </div>
  );
}

function DashboardLoading({ copy }: { copy: DashboardCopy }) {
  return (
    <main aria-busy="true" aria-label={copy.loading} className={styles.shell}>
      <span className={styles.srOnly}>{copy.loading}</span>
      <div className={styles.skeletonHero}><i /><i /><i /></div>
      <div className={styles.skeletonSafety}><i /><i /><i /></div>
      <div className={styles.skeletonGrid}><div><i /><i /><i /></div><div><i /><i /></div></div>
    </main>
  );
}

function DashboardPermission({ copy }: { copy: DashboardCopy }) {
  return (
    <main className={styles.shell}>
      <section className={styles.statePanel}>
        <span className={styles.errorMark} aria-hidden="true">×</span>
        <div><h1>{copy.permissionTitle}</h1><p>{copy.permissionBody}</p></div>
        <a className={styles.secondaryButton} href="/">{copy.back}</a>
      </section>
    </main>
  );
}

function formatRelative(value: string, locale: string): string {
  const minutes = Math.round((Date.parse(value) - Date.parse('2026-07-30T19:20:00Z')) / 60_000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  return formatter.format(Math.round(minutes / 60), 'hour');
}
