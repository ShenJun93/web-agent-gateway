import type { GatewayAuthority } from '../caller-context.js';
import type {
  BrowserControlState,
  BrowserExecutionMode,
  BrowserOpenMode,
  BrowserOpenRequest,
  BrowserOwnershipMode,
  BrowserPort,
  BrowserSessionHandle,
  BrowserSnapshot,
  BrowserExecRequest,
} from './browser-port.js';

interface RoutedSession {
  port: BrowserPort;
  executionMode: BrowserExecutionMode;
  ownershipMode: BrowserOwnershipMode;
  controlState: BrowserControlState;
}

export class BrowserBrokerError extends Error {
  constructor(
    readonly code:
      | 'ATTACH_EXISTING_NOT_CONFIGURED'
      | 'BROWSER_MODE_UNAVAILABLE'
      | 'BROWSER_SESSION_NOT_ROUTED'
      | 'BROWSER_AUTOMATION_PAUSED',
    message: string,
  ) {
    super(message);
    this.name = 'BrowserBrokerError';
  }
}

export interface BrowserBroker extends BrowserPort {
  recover(owner: GatewayAuthority, browserSessionId: string): Promise<BrowserSessionHandle>;
  pauseForUser(owner: GatewayAuthority, browserSessionId: string): Promise<BrowserSessionHandle>;
  takeUserControl(owner: GatewayAuthority, browserSessionId: string): Promise<BrowserSessionHandle>;
  resumeAutomation(owner: GatewayAuthority, browserSessionId: string): Promise<BrowserSessionHandle>;
}

export function resolveBrowserOpenMode(
  mode: BrowserOpenMode | undefined,
  targetId?: string,
): BrowserExecutionMode {
  const requested = mode ?? 'AUTO';
  // AUTO is deterministic and never guesses a tab. Once the caller has selected an exact target
  // from browser.targets, use the visible AI tab group so the user can observe/take over without
  // foreground focus or OS-pointer ownership. With no exact target, preserve isolated headless.
  if (requested === 'AUTO') return targetId === undefined ? 'WAG_HEADLESS' : 'AI_TAB_GROUP';
  return requested;
}

function decorate(handle: BrowserSessionHandle, route: RoutedSession): BrowserSessionHandle {
  return Object.freeze({
    ...handle,
    executionMode: route.executionMode,
    ownershipMode: route.ownershipMode,
    controlState: route.controlState,
  });
}

export function createBrowserBroker(options: {
  headless: BrowserPort;
  visible: BrowserPort;
  attached?: BrowserPort & {
    recover?: (owner: GatewayAuthority, browserSessionId: string) => Promise<BrowserSessionHandle>;
  };
}): BrowserBroker {
  const routes = new Map<string, RoutedSession>();

  function routeFor(browserSessionId: string): RoutedSession {
    const route = routes.get(browserSessionId);
    if (!route) {
      throw new BrowserBrokerError('BROWSER_SESSION_NOT_ROUTED', 'Browser session is not routed');
    }
    return route;
  }

  function portFor(mode: BrowserExecutionMode): {
    port: BrowserPort;
    ownershipMode: BrowserOwnershipMode;
  } {
    if (mode === 'WAG_HEADLESS') return { port: options.headless, ownershipMode: 'WAG_OWNED' };
    if (mode === 'WAG_VISIBLE') return { port: options.visible, ownershipMode: 'WAG_OWNED' };
    if (!options.attached) {
      throw new BrowserBrokerError(
        'ATTACH_EXISTING_NOT_CONFIGURED',
        'Existing-browser runtime bridge is not configured',
      );
    }
    return { port: options.attached, ownershipMode: 'ATTACHED_EXISTING' };
  }

  function assertAutomationAllowed(route: RoutedSession): void {
    if (route.controlState !== 'RUNNING') {
      throw new BrowserBrokerError(
        'BROWSER_AUTOMATION_PAUSED',
        'Browser automation is paused for user control',
      );
    }
  }

  async function described(
    owner: GatewayAuthority,
    browserSessionId: string,
    route: RoutedSession,
  ): Promise<BrowserSessionHandle> {
    return decorate(await route.port.describe(owner, browserSessionId), route);
  }

  return {
    async recover(owner, browserSessionId) {
      if (!options.attached?.recover) {
        throw new BrowserBrokerError(
          'BROWSER_SESSION_NOT_ROUTED',
          'Browser session recovery is not configured',
        );
      }
      const handle = await options.attached.recover(owner, browserSessionId);
      if (handle.executionMode !== 'ATTACH_EXISTING' && handle.executionMode !== 'AI_TAB_GROUP') {
        throw new BrowserBrokerError(
          'BROWSER_MODE_UNAVAILABLE',
          'Only attached existing browser sessions are recoverable',
        );
      }
      const route: RoutedSession = {
        port: options.attached,
        executionMode: handle.executionMode,
        ownershipMode: 'ATTACHED_EXISTING',
        controlState: handle.controlState ?? 'RUNNING',
      };
      routes.set(browserSessionId, route);
      return decorate(handle, route);
    },

    async open(request: BrowserOpenRequest) {
      const executionMode = resolveBrowserOpenMode(request.mode, request.targetId);
      const selected = portFor(executionMode);
      const handle = await selected.port.open({ ...request, mode: executionMode });
      const route: RoutedSession = {
        port: selected.port,
        executionMode,
        ownershipMode: selected.ownershipMode,
        controlState: 'RUNNING',
      };
      routes.set(handle.browserSessionId, route);
      return decorate(handle, route);
    },

    describe(owner, browserSessionId) {
      const route = routeFor(browserSessionId);
      return described(owner, browserSessionId, route);
    },

    async snapshot(owner, browserSessionId): Promise<BrowserSnapshot> {
      const route = routeFor(browserSessionId);
      assertAutomationAllowed(route);
      return route.port.snapshot(owner, browserSessionId);
    },

    async exec(owner, browserSessionId, request: BrowserExecRequest) {
      const route = routeFor(browserSessionId);
      assertAutomationAllowed(route);
      return route.port.exec(owner, browserSessionId, request);
    },

    async screenshot(owner, browserSessionId) {
      const route = routeFor(browserSessionId);
      assertAutomationAllowed(route);
      return route.port.screenshot(owner, browserSessionId);
    },

    async close(owner, browserSessionId) {
      const route = routeFor(browserSessionId);
      const handle = await route.port.close(owner, browserSessionId);
      route.controlState = 'STOPPED';
      routes.delete(browserSessionId);
      return decorate(handle, route);
    },

    async pauseForUser(owner, browserSessionId) {
      const route = routeFor(browserSessionId);
      if (route.executionMode !== 'WAG_VISIBLE' && route.executionMode !== 'AI_TAB_GROUP') {
        throw new BrowserBrokerError(
          'BROWSER_MODE_UNAVAILABLE',
          'User takeover is available only for visible WAG sessions',
        );
      }
      await route.port.describe(owner, browserSessionId);
      route.controlState = 'PAUSED_FOR_USER';
      return described(owner, browserSessionId, route);
    },

    async takeUserControl(owner, browserSessionId) {
      const route = routeFor(browserSessionId);
      if ((route.executionMode !== 'WAG_VISIBLE' && route.executionMode !== 'AI_TAB_GROUP')
          || route.controlState !== 'PAUSED_FOR_USER') {
        throw new BrowserBrokerError(
          'BROWSER_MODE_UNAVAILABLE',
          'Browser session is not ready for user control',
        );
      }
      await route.port.describe(owner, browserSessionId);
      route.controlState = 'USER_CONTROL';
      return described(owner, browserSessionId, route);
    },

    async resumeAutomation(owner, browserSessionId) {
      const route = routeFor(browserSessionId);
      if ((route.executionMode !== 'WAG_VISIBLE' && route.executionMode !== 'AI_TAB_GROUP')
          || (route.controlState !== 'USER_CONTROL' && route.controlState !== 'PAUSED_FOR_USER')) {
        throw new BrowserBrokerError(
          'BROWSER_MODE_UNAVAILABLE',
          'Browser session is not paused for user control',
        );
      }
      route.controlState = 'RESUMING';
      // Revalidate the target binding before allowing another semantic effect. Task 1 uses the
      // current BrowserPort snapshot; richer target-generation validation lands with Tasks 2-4.
      await route.port.snapshot(owner, browserSessionId);
      route.controlState = 'RUNNING';
      return described(owner, browserSessionId, route);
    },
  };
}
