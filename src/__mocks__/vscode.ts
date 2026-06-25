// Minimal vscode stub for unit tests. Only covers what pure-function tests need.
export const window = {
  createOutputChannel: () => ({
    appendLine: () => {},
    show: () => {},
    dispose: () => {},
  }),
  showErrorMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
  showInformationMessage: () => Promise.resolve(undefined),
};

export const ProgressLocation = { Notification: 15 };

export const Uri = { parse: (s: string) => ({ toString: () => s }) };
