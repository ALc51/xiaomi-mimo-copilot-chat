const Module = require('node:module');

class LanguageModelTextPart {
  constructor(value) {
    this.value = value;
  }
}

class LanguageModelToolCallPart {
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

class LanguageModelToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = Array.isArray(content) ? content : [content];
  }
}

class LanguageModelDataPart {
  constructor(data, mimeType) {
    this.data = data;
    this.mimeType = mimeType;
  }
}

class CancellationError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'CancellationError';
  }
}

class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }
  fire(data) {
    for (const l of this.listeners) l(data);
  }
  dispose() {
    this.listeners.clear();
  }
}

const mockVscode = {
  CancellationError,
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LanguageModelDataPart,
  EventEmitter,
  ThemeColor: class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  },
  ThemeIcon: class ThemeIcon {
    constructor(id) {
      this.id = id;
    }
  },
  Uri: {
    parse: (str) => ({ path: str, toString: () => str }),
    joinPath: (base, ...paths) => ({
      path: `${base?.path || ''}/${paths.join('/')}`,
      toString: () => `${base?.path || ''}/${paths.join('/')}`,
    }),
    from: (components) => components,
  },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showInputBox: async () => undefined,
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key, def) => def,
    }),
  },
};

const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'vscode') {
    return 'vscode';
  }
  return orig.call(this, request, ...args);
};

require.cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: mockVscode,
};

