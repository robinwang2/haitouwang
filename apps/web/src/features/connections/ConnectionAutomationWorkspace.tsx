'use client';

import { useMemo } from 'react';
import {
  AutomationControlPanel,
  ManualTakeoverPanel,
  createAutomationMockGateway,
  type AutomationGateway,
  type AutomationPermission,
} from '../automation';
import { ConnectionsPanel } from './ConnectionsPanel';
import { createConnectionsMockGateway } from './mockGateway';
import type { ConnectionGateway, ConnectionPermission } from './types';
import styles from './connections.module.css';

export interface ConnectionAutomationWorkspaceProps {
  readonly connectionGateway?: ConnectionGateway;
  readonly automationGateway?: AutomationGateway;
  readonly connectionPermission?: ConnectionPermission;
  readonly automationPermission?: AutomationPermission;
}

/**
 * Mountable feature surface for this ticket. When gateways are omitted it uses
 * clearly labelled, safe-default in-memory mocks for frontend integration.
 */
export function ConnectionAutomationWorkspace({
  connectionGateway,
  automationGateway,
  connectionPermission,
  automationPermission,
}: ConnectionAutomationWorkspaceProps) {
  const mockConnections = useMemo(() => createConnectionsMockGateway(), []);
  const mockAutomation = useMemo(() => createAutomationMockGateway(), []);
  const connections = connectionGateway ?? mockConnections;
  const automation = automationGateway ?? mockAutomation;

  return (
    <main className={styles.workspace}>
      <div className={styles.workspaceInner}>
        <header className={styles.workspaceHeader}>
          <div>
            <h1>连接与自动化</h1>
            <p>
              管理本地代理、职位来源、自动化边界与人工接管。所有未知状态都会安全降级为关闭或暂停。
            </p>
          </div>
          <div className={styles.safeDefault}>
            <span className={styles.safeDot} />
            自动提交固定关闭
          </div>
        </header>

        <ConnectionsPanel gateway={connections} permission={connectionPermission} />
        <AutomationControlPanel gateway={automation} permission={automationPermission} />
        <ManualTakeoverPanel gateway={automation} permission={automationPermission} />
      </div>
    </main>
  );
}
