/// <reference types="vite/client" />
export {};
declare global {
  interface Window {
    desktop?: {
      terminalWindow: {
        appearance?: (theme: 'light' | 'dark') => Promise<{ nativeControls: boolean }>;
        focus: () => Promise<boolean>;
        onClosed: (callback: () => void) => () => void;
        onRequestClose?: (callback: () => void) => () => void;
        control?: (action: 'minimize' | 'maximize' | 'destroy') => Promise<boolean>;
        setActive?: (active: boolean) => Promise<void>;
        finishClose?: (allowed: boolean) => Promise<void>;
        onState?: (callback: (state: { maximized: boolean }) => void) => () => void;
      };
      // Run from the source tree, not installed: the login page then also offers the simulation service.
      dev: boolean;
      platform: 'win32' | 'darwin' | 'linux';
      preview: {
        read: (input: {
          path: string;
          root?: string;
          restricted?: boolean;
        }) => Promise<import('./preview.ts').PreviewFile>;
        releaseFile: (token: string) => Promise<void>;
        pick: (surface?: import('./preview.ts').PreviewSurface) => Promise<string | null>;
        show: (
          input: import('./preview.ts').PreviewView & {
            url: string;
            bounds: import('./preview.ts').PreviewBounds;
          },
        ) => Promise<void>;
        bounds: (input: {
          surface: import('./preview.ts').PreviewSurface;
          bounds: import('./preview.ts').PreviewBounds | null;
        }) => Promise<void>;
        hide: (surface: import('./preview.ts').PreviewSurface) => Promise<void>;
        action: (
          input: import('./preview.ts').PreviewView & {
            action: 'go' | 'back' | 'forward' | 'reload';
            url?: string;
          },
        ) => Promise<void>;
        release: (input: import('./preview.ts').PreviewView) => Promise<void>;
        onState: (
          callback: (state: import('./preview.ts').PreviewBrowserState) => void,
        ) => () => void;
      };
      // Which of this computer's connections the window is ('' the first), and what they all share.
      boot: { connection: string; shared: import('./shared.ts').Shared };
      saveShared: (key: 'prefs' | 'projects', value: unknown) => Promise<void>;
      onSharedChanged: (
        callback: (key: keyof import('./shared.ts').Shared, value: unknown) => void,
      ) => () => void;
      // The sessions running in this window, for the other connections' windows to warn about.
      setBusy: (runs: import('./shared.ts').Run[]) => Promise<void>;
      // Each connection is a window of its own; `open` tells whether it is running now.
      connections: () => Promise<import('./shared.ts').ListedConnection[]>;
      createConnection: (name: string) => Promise<import('./shared.ts').ListedConnection[]>;
      openConnection: (id: string) => Promise<void>;
      renameConnection: (
        id: string,
        name: string,
      ) => Promise<import('./shared.ts').ListedConnection[]>;
      removeConnection: (id: string) => Promise<import('./shared.ts').ListedConnection[]>;
      chooseProject: () => Promise<string | null>;
      asOnDisk: (path: string) => Promise<string>;
      // Whether each folder is on this computer, in the order given.
      foldersExist: (folders: string[]) => Promise<boolean[]>;
      // Files to mention in a message; the paths of the ones chosen.
      chooseFiles: () => Promise<string[]>;
      pathForFile: (file: File) => string;
      // Asks where to save and writes the text there; false when the dialog was cancelled.
      saveTerminalFile: (
        name: string,
        data: string,
        encoding: 'utf8' | 'base64',
      ) => Promise<boolean>;
      readTerminalText: (path: string) => Promise<string>;
      saveFile: (name: string, text: string) => Promise<boolean>;
      openFolder: (path: string) => Promise<void>;
      openLogs: () => Promise<void>;
      openDevTools: () => Promise<void>;
      saveImage: (type: string, bytes: Uint8Array) => Promise<string>;
      // A bounded local thumbnail, never the original full-size file or executable SVG markup.
      attachmentPreview: (path: string) => Promise<string | null>;
      // The branch a project's working tree is on, or null outside a repository.
      gitBranch: (path: string) => Promise<string | null>;
      copyText: (text: string) => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      openWeb: (url: string) => Promise<void>;
      // A web address a reply links to, in the user's browser.
      openLink: (url: string) => Promise<void>;
      // What a path a reply links to is on this computer; `runs` when opening it would run something.
      // `editors` are the installed code editors, the one to use first.
      inspectPath: (path: string) => Promise<{
        kind: 'file' | 'directory' | 'missing';
        runs: boolean;
        editors: { scheme: string; name: string }[];
        openWith: boolean;
      }>;
      // Does something with a linked path; what to tell the user, or ''.
      actOnPath: (
        action: 'open' | 'default' | 'editor' | 'with' | 'reveal' | 'content' | 'save',
        path: string,
        options?: { line?: number; column?: number; editor?: string },
      ) => Promise<string>;
      // The folders holding sessions without a project; new ones are made in the first.
      workspaceRoots: () => Promise<string[]>;
      // Asks for another folder, or goes back to the one under Documents; the folders as they are afterwards.
      chooseWorkspace: (reset: boolean) => Promise<string[]>;
      createWorkspace: () => Promise<string>;
      removeWorkspace: (directory: string) => Promise<void>;
      loadLogin: () => Promise<import('./LoginPage.tsx').ConnectionForm | null>;
      saveLogin: (login: import('./LoginPage.tsx').ConnectionForm) => Promise<void>;
      access: {
        load: () => Promise<{ email: string; remember: boolean; autoLogin: boolean } | null>;
        login: (input: {
          email: string;
          password: string;
          remember: boolean;
          autoLogin: boolean;
        }) => Promise<{ email: string; workspaces: { id: string; name: string }[] }>;
        ticket: (
          nodeId: string,
        ) => Promise<
          | { url: string; fingerprint: string; token: string }
          | { error: string; retryable: boolean }
        >;
        logout: () => Promise<void>;
        onExpired: (callback: (message: string) => void) => () => void;
      };
      loadDrafts: () => Promise<import('./drafts.ts').SavedDrafts>;
      saveDrafts: (drafts: import('./drafts.ts').SavedDrafts) => Promise<void>;
      loadSchedules: (initial: string) => Promise<{ path: string; text: string }>;
      saveSchedules: (text: string) => Promise<void>;
      onSchedulesChanged: (callback: (text: string) => void) => () => void;
      windowSettings: () => Promise<{ closeToTray: boolean }>;
      setWindowSettings: (values: { closeToTray: boolean }) => Promise<void>;
      // A system notification, shown unless the window is in front (`always` shows it regardless). `attention`
      // also flashes the taskbar button, or bounces the Dock icon, of a window left open behind others.
      notify: (notice: {
        title: string;
        body: string;
        sessionId: string | null;
        silent: boolean;
        always?: boolean;
        attention?: boolean;
      }) => Promise<void>;
      onNotifyClicked: (callback: (sessionId: string | null) => void) => () => void;
      // 1 and -1 step the interface size, 0 restores it.
      zoom: (direction: number) => void;
      // `all` also closes the windows of the other connections.
      quit: (all?: boolean) => Promise<void>;
      version: () => Promise<string>;
      managedServer: {
        check: (
          connection: import('./ManagedServerUpgrade.tsx').ManagedServerConnection,
        ) => Promise<import('../../server/src/managed-server-http.ts').ServerCheck>;
        install: (
          confirmation: import('./ManagedServerUpgrade.tsx').ManagedServerConfirmation,
        ) => Promise<{ accepted: true; build: number; sha256: string }>;
        status: (
          connection: import('./ManagedServerUpgrade.tsx').ManagedServerConnection,
        ) => Promise<import('../../server/src/managed-server-http.ts').ServerStatus>;
        cancel: () => Promise<void>;
        openManager: () => Promise<void>;
      };
      managedUpdate: {
        state: () => Promise<import('./managed-update.ts').ManagedUpdateState>;
        check: () => Promise<import('./managed-update.ts').ManagedUpdateState>;
        download: () => Promise<import('./managed-update.ts').ManagedUpdateState>;
        install: () => Promise<import('./managed-update.ts').ManagedUpdateState>;
        cancel: () => Promise<import('./managed-update.ts').ManagedUpdateState>;
        activity: (value: { blocked: boolean }) => Promise<void>;
        subscribe: (
          callback: (state: import('./managed-update.ts').ManagedUpdateState) => void,
        ) => () => void;
      };
      // The notes of a released version, read from its page on GitHub.
      releaseNotes: (version: string) => Promise<string>;
      // This computer as the service knows it.
      device: () => Promise<import('@cc-desk-tunnel/protocol').Device>;
      // Fetches and runs an installer: the one the connected service holds, or, given a version, that
      // version's from the release page.
      installUpdate: (version?: string) => Promise<void>;
      onUpdateProgress: (
        callback: (progress: { received: number; size: number }) => void,
      ) => () => void;
      // Has a service that refused this client as the newer one upgrade itself to the newest release, given
      // the service's version from the refusal; ends with the version installed or why it was not.
      upgradeService: (config: {
        url: string;
        fingerprint: string;
        token: string;
        deviceName: string;
        service: string;
      }) => Promise<{ version?: string; error?: string }>;
      onServiceUpgrade: (
        callback: (update: import('@cc-desk-tunnel/protocol').ServiceUpdate) => void,
      ) => () => void;
      connectProxy: (config: {
        url: string;
        fingerprint: string;
        // Seconds allowed for reaching the service, for the local SSH service to start, and for the whole.
        waits?: { connect: number; ssh: number; ready: number };
      }) => Promise<{ url: string }>;
      disconnectProxy: () => Promise<void>;
      onProxyClosed: (callback: () => void) => () => void;
    };
  }
}
