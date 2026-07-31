'use client';

import { type FormEvent, type KeyboardEvent, useRef, useState } from 'react';
import type { AsyncState, Fact, Material, ProfileCapabilities } from './contracts';
import { mockFacts, mockGoals, mockMaterials } from './mock-api';
import { profileMessages, type ProfileCopy } from './messages';
import {
  factStatusTone,
  humanizeFactValue,
  materialLabel,
  nextProfileTab,
  resolveProfileState,
  type ProfileTab,
  validateGoal,
} from './model';
import styles from './profile.module.css';

type ProfileWorkspaceProps = {
  state?: AsyncState;
  capabilities?: ProfileCapabilities;
  facts?: Fact[];
  materials?: Material[];
  copy?: ProfileCopy;
  locale?: string;
  requestId?: string;
  onRetry?: () => void;
};

const statusCopy: Record<string, keyof ProfileCopy> = {
  active: 'active',
  pending_confirmation: 'pending',
  expired: 'expired',
  prohibited: 'prohibited',
};

export function ProfileWorkspace({
  state = 'ready',
  capabilities = { canView: true, canEdit: true },
  facts = mockFacts.items,
  materials = mockMaterials.items,
  copy = profileMessages.en,
  locale = 'en-US',
  requestId = 'req_profile_mock_01',
  onRetry,
}: ProfileWorkspaceProps) {
  const pageState = resolveProfileState(state, capabilities.canView);
  const [tab, setTab] = useState<ProfileTab>('onboarding');
  const [announcement, setAnnouncement] = useState('');
  const tabRefs = useRef<Record<ProfileTab, HTMLButtonElement | null>>({
    onboarding: null,
    facts: null,
    resumes: null,
  });

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const destination = nextProfileTab(tab, event.key);
    if (!destination) return;
    event.preventDefault();
    setTab(destination);
    tabRefs.current[destination]?.focus();
  }

  if (pageState === 'loading') return <ProfileLoading copy={copy} />;
  if (pageState === 'permission') return <ProfilePermission copy={copy} />;
  if (pageState === 'error') {
    return (
      <main className={styles.shell}>
        <section className={styles.statePanel} role="alert">
          <span className={styles.stateIcon} aria-hidden="true">!</span>
          <div>
            <h1>{copy.errorTitle}</h1>
            <p>{copy.errorBody}</p>
            <p className={styles.requestId}>{copy.requestLabel}: {requestId}</p>
          </div>
          <button className={styles.primaryButton} onClick={onRetry} type="button">{copy.retry}</button>
        </section>
      </main>
    );
  }
  if (pageState === 'empty') return <ProfileEmpty copy={copy} />;

  return (
    <main className={styles.shell}>
      {pageState === 'paused' && (
        <aside className={styles.pauseBanner} role="status">
          <span className={styles.pauseMark} aria-hidden="true">Ⅱ</span>
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
        <div className={styles.readiness} aria-label={`${copy.progress}: 72%`}>
          <span>{copy.progress}</span>
          <strong>72%</strong>
          <div className={styles.progressTrack} aria-hidden="true"><span /></div>
        </div>
      </header>

      <div className={styles.tabList} role="tablist" aria-label={copy.title}>
        {(['onboarding', 'facts', 'resumes'] as const).map((item) => (
          <button
            aria-controls={`profile-panel-${item}`}
            aria-selected={tab === item}
            className={styles.tab}
            id={`profile-tab-${item}`}
            key={item}
            onClick={() => setTab(item)}
            onKeyDown={onTabKeyDown}
            ref={(node) => { tabRefs.current[item] = node; }}
            role="tab"
            tabIndex={tab === item ? 0 : -1}
            type="button"
          >
            {copy.tabs[item]}
            {item === 'facts' && <span className={styles.count}>{facts.filter((fact) => fact.status === 'pending_confirmation').length}</span>}
          </button>
        ))}
      </div>

      <section
        aria-labelledby={`profile-tab-${tab}`}
        className={styles.panel}
        id={`profile-panel-${tab}`}
        role="tabpanel"
        tabIndex={0}
      >
        {tab === 'onboarding' && (
          <OnboardingForm
            canEdit={capabilities.canEdit}
            copy={copy}
            onAnnouncement={setAnnouncement}
          />
        )}
        {tab === 'facts' && (
          <FactConfirmation
            canEdit={capabilities.canEdit}
            copy={copy}
            facts={facts}
            onAnnouncement={setAnnouncement}
          />
        )}
        {tab === 'resumes' && (
          <ResumeLibrary canEdit={capabilities.canEdit} copy={copy} locale={locale} materials={materials} />
        )}
      </section>
      <p className={styles.srOnly} role="status" aria-live="polite">{announcement}</p>
    </main>
  );
}

function OnboardingForm({
  canEdit,
  copy,
  onAnnouncement,
}: {
  canEdit: boolean;
  copy: ProfileCopy;
  onAnnouncement: (message: string) => void;
}) {
  const goal = mockGoals.items[0];
  const [errors, setErrors] = useState<Array<'name' | 'keywords' | 'employmentTypes'>>([]);
  const errorRef = useRef<HTMLDivElement>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nextErrors = validateGoal({
      name: String(data.get('goal-name') ?? ''),
      keywords: String(data.get('role-keywords') ?? ''),
      employmentTypes: data.getAll('employment-type').map(String),
    });
    setErrors(nextErrors);
    if (nextErrors.length) {
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    onAnnouncement(copy.saved);
  }

  return (
    <form className={styles.formLayout} noValidate onSubmit={submit}>
      <div className={styles.sectionHeading}>
        <span className={styles.stepNumber} aria-hidden="true">01</span>
        <div><h2>{copy.goalHeading}</h2><p>{copy.description}</p></div>
      </div>
      {errors.length > 0 && (
        <div className={styles.errorSummary} ref={errorRef} role="alert" tabIndex={-1}>
          <strong>{copy.requiredSummary}</strong>
          <ul>
            {errors.includes('name') && <li><a href="#goal-name">{copy.nameRequired}</a></li>}
            {errors.includes('keywords') && <li><a href="#role-keywords">{copy.keywordsRequired}</a></li>}
            {errors.includes('employmentTypes') && <li><a href="#employment-full-time">{copy.employmentRequired}</a></li>}
          </ul>
        </div>
      )}
      <div className={styles.formGrid}>
        <label className={styles.field}>
          <span>{copy.goalName} <small>{copy.required}</small></span>
          <input
            aria-describedby={errors.includes('name') ? 'goal-name-error' : undefined}
            aria-invalid={errors.includes('name')}
            defaultValue={goal.name}
            id="goal-name"
            name="goal-name"
            readOnly={!canEdit}
          />
          {errors.includes('name') && <em id="goal-name-error">{copy.nameRequired}</em>}
        </label>
        <label className={styles.field}>
          <span>{copy.roleKeywords} <small>{copy.required}</small></span>
          <input
            aria-describedby={errors.includes('keywords') ? 'role-keywords-error' : undefined}
            aria-invalid={errors.includes('keywords')}
            defaultValue={goal.title_keywords.join(', ')}
            id="role-keywords"
            name="role-keywords"
            readOnly={!canEdit}
          />
          {errors.includes('keywords') && <em id="role-keywords-error">{copy.keywordsRequired}</em>}
        </label>
        <label className={styles.field}>
          <span>{copy.locations}</span>
          <input defaultValue={goal.locations.join(', ')} name="locations" readOnly={!canEdit} />
        </label>
        <label className={styles.field}>
          <span>{copy.authorization}</span>
          <select defaultValue={goal.work_authorization_rule} disabled={!canEdit} name="authorization">
            <option value="authorized">{copy.authorized}</option>
            <option value="requires_sponsorship">{copy.sponsorship}</option>
            <option value="unknown">{copy.authorizationUnknown}</option>
            <option value="manual_only">{copy.manualOnly}</option>
          </select>
        </label>
      </div>
      <fieldset className={styles.checkGroup}>
        <legend>{copy.employment} <small>{copy.required}</small></legend>
        <label>
          <input defaultChecked disabled={!canEdit} id="employment-full-time" name="employment-type" type="checkbox" value="full_time" />
          {copy.fullTime}
        </label>
        <label><input disabled={!canEdit} name="employment-type" type="checkbox" value="contract" /> {copy.contract}</label>
        <label><input disabled={!canEdit} name="employment-type" type="checkbox" value="internship" /> {copy.internship}</label>
      </fieldset>
      <div className={styles.formFooter}>
        {!canEdit && <p className={styles.readonlyNote}>{copy.readonly}</p>}
        <button className={styles.primaryButton} disabled={!canEdit} type="submit">{copy.saveGoal}</button>
      </div>
    </form>
  );
}

function FactConfirmation({
  canEdit,
  copy,
  facts,
  onAnnouncement,
}: {
  canEdit: boolean;
  copy: ProfileCopy;
  facts: Fact[];
  onAnnouncement: (message: string) => void;
}) {
  const [decisions, setDecisions] = useState<Record<string, 'confirmed' | 'rejected'>>({});
  return (
    <div>
      <div className={styles.contentTitle}><div><h2>{copy.factHeading}</h2><p>{copy.factHelp}</p></div></div>
      {!canEdit && <p className={styles.readonlyNote}>{copy.readonly}</p>}
      <ul className={styles.factList}>
        {facts.map((fact) => {
          const status = decisions[fact.id] === 'confirmed' ? 'active' : decisions[fact.id] === 'rejected' ? 'rejected' : fact.status;
          const labelKey = statusCopy[status] ?? (status === 'rejected' ? 'rejected' : 'unavailable');
          return (
            <li className={styles.factCard} key={fact.id}>
              <div className={styles.factTopline}>
                <span className={styles.kind}>{fact.kind.replace('_', ' ')}</span>
                <span className={`${styles.badge} ${styles[factStatusTone(status)]}`}>
                  <span aria-hidden="true">{factStatusTone(status) === 'positive' ? '✓' : '!'}</span>
                  {copy[labelKey] as string}
                </span>
              </div>
              <h3>{humanizeFactValue(fact.value)}</h3>
              <dl>
                <div><dt>{copy.factSource}</dt><dd>{fact.source.reference}</dd></div>
                <div><dt>{copy.factScope}</dt><dd>{fact.scope.use.replaceAll('_', ' ')}</dd></div>
                <div><dt>{copy.version}</dt><dd>{fact.version}</dd></div>
              </dl>
              {fact.status === 'pending_confirmation' && !decisions[fact.id] && (
                <div className={styles.cardActions}>
                  <button
                    className={styles.secondaryButton}
                    disabled={!canEdit}
                    onClick={() => {
                      setDecisions((current) => ({ ...current, [fact.id]: 'rejected' }));
                      onAnnouncement(copy.factUpdated);
                    }}
                    type="button"
                  >{copy.reject}</button>
                  <button
                    className={styles.primaryButton}
                    disabled={!canEdit}
                    onClick={() => {
                      setDecisions((current) => ({ ...current, [fact.id]: 'confirmed' }));
                      onAnnouncement(copy.factUpdated);
                    }}
                    type="button"
                  >{copy.confirm}</button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ResumeLibrary({
  canEdit,
  copy,
  locale,
  materials,
}: {
  canEdit: boolean;
  copy: ProfileCopy;
  locale: string;
  materials: Material[];
}) {
  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  return (
    <div>
      <div className={styles.contentTitle}>
        <div><h2>{copy.resumeHeading}</h2><p>{copy.resumeHelp}</p></div>
        <button className={styles.primaryButton} disabled={!canEdit} type="button">{copy.uploadResume}</button>
      </div>
      {materials.length === 0 ? (
        <div className={styles.inlineEmpty}><h3>{copy.resumeEmpty}</h3><button disabled={!canEdit} type="button">{copy.uploadResume}</button></div>
      ) : (
        <ul className={styles.resumeGrid}>
          {materials.filter((material) => material.kind === 'resume').map((material) => (
            <li className={styles.resumeCard} key={material.id}>
              <div className={styles.documentIcon} aria-hidden="true"><span /></div>
              <div>
                <span className={styles.kind}>{materialLabel(material) === 'base' ? copy.baseResume : copy.tailoredResume}</span>
                <h3>{materialLabel(material) === 'base' ? 'Product engineer — master' : 'Northstar — Frontend Engineer'}</h3>
                <p>{copy.version} {material.version} · {material.fact_citations.length} {copy.citations}</p>
                <p>{copy.updated} {formatter.format(new Date(material.updated_at))}</p>
              </div>
              <span className={`${styles.badge} ${material.status === 'approved' ? styles.positive : styles.warning}`}>
                {copy[material.status === 'review_required' ? 'reviewRequired' : material.status] as string}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProfileLoading({ copy }: { copy: ProfileCopy }) {
  return (
    <main aria-busy="true" aria-label={copy.loading} className={styles.shell}>
      <span className={styles.srOnly}>{copy.loading}</span>
      <div className={styles.skeletonHero}><i /><i /><i /></div>
      <div className={styles.skeletonTabs}><i /><i /><i /></div>
      <div className={styles.skeletonPanel}><i /><i /><i /><i /></div>
    </main>
  );
}

function ProfileEmpty({ copy }: { copy: ProfileCopy }) {
  return (
    <main className={styles.shell}>
      <section className={styles.statePanel}>
        <span className={styles.emptyMark} aria-hidden="true">＋</span>
        <div><p className={styles.eyebrow}>{copy.eyebrow}</p><h1>{copy.emptyTitle}</h1><p>{copy.emptyBody}</p></div>
        <button className={styles.primaryButton} type="button">{copy.start}</button>
      </section>
    </main>
  );
}

function ProfilePermission({ copy }: { copy: ProfileCopy }) {
  return (
    <main className={styles.shell}>
      <section className={styles.statePanel}>
        <span className={styles.stateIcon} aria-hidden="true">×</span>
        <div><h1>{copy.permissionTitle}</h1><p>{copy.permissionBody}</p></div>
        <a className={styles.secondaryButton} href="/">{copy.back}</a>
      </section>
    </main>
  );
}
