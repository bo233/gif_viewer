import * as vscode from 'vscode';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
  const provider = new GifCustomEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('gifViewer.viewer', provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    })
  );
}

export function deactivate() {}

interface ReloadMessage {
  type: 'reloaded';
  bytes: Uint8Array;
}

interface WebviewOutMessage {
  type: 'reload';
  data: string; // base64
}

interface WebviewInMessageRequestBytes {
  type: 'requestBytes';
}

type WebviewInMessage = WebviewInMessageRequestBytes; // 可扩展

class GifDocument implements vscode.CustomDocument {
  public readonly uri: vscode.Uri;
  private readonly _onDidDispose = new vscode.EventEmitter<void>();
  public readonly onDidDispose = this._onDidDispose.event;
  private _watcher?: vscode.FileSystemWatcher;
  private readonly _onDidChange = new vscode.EventEmitter<ReloadMessage>();
  public readonly onDidChange = this._onDidChange.event;

  private constructor(uri: vscode.Uri) {
    this.uri = uri;
  }

  static async create(uri: vscode.Uri): Promise<GifDocument> {
    const doc = new GifDocument(uri);
    doc._watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(uri.fsPath), path.basename(uri.fsPath)));
    doc._watcher.onDidChange(async () => {
      const bytes = await vscode.workspace.fs.readFile(uri);
      doc._onDidChange.fire({ type: 'reloaded', bytes });
    });
    doc._watcher.onDidDelete(() => {
      // no-op for now
    });
    return doc;
  }

  async getBytes(): Promise<Uint8Array> {
    return vscode.workspace.fs.readFile(this.uri);
  }

  dispose(): void {
    this._watcher?.dispose();
    this._onDidDispose.fire();
    this._onDidDispose.dispose();
    this._onDidChange.dispose();
  }
}

class GifCustomEditorProvider implements vscode.CustomReadonlyEditorProvider<GifDocument> {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<GifDocument> {
    return GifDocument.create(uri);
  }

  async resolveCustomEditor(document: GifDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))]
    };

  const bytes = await document.getBytes();
  const large = bytes.byteLength > 10 * 1024 * 1024; // 10MB

  webviewPanel.webview.html = this.getHtml(webviewPanel.webview, bytes, large);

    document.onDidChange(async (e: ReloadMessage) => {
      if (e.type === 'reloaded') {
        try {
          const newBytesBase64 = Buffer.from(e.bytes).toString('base64');
          const msg: WebviewOutMessage = { type: 'reload', data: newBytesBase64 };
          webviewPanel.webview.postMessage(msg);
        } catch (err) {
          console.error('Failed sending reload message', err);
        }
      }
    });

    webviewPanel.webview.onDidReceiveMessage((msg: WebviewInMessage) => {
      switch (msg.type) {
        case 'requestBytes': {
          (async () => {
            try {
              const b = await document.getBytes();
              webviewPanel.webview.postMessage({ type: 'reload', data: Buffer.from(b).toString('base64') });
            } catch (err) {
              console.error('Failed to read bytes', err);
            }
          })();
          break;
        }
      }
    });
  }

  private getHtml(webview: vscode.Webview, bytes: Uint8Array, large: boolean): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', 'main.js')));
    const nonce = getNonce();
    const base64 = Buffer.from(bytes).toString('base64');
  return `<!DOCTYPE html>
<html lang="zh-cn">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>GIF Viewer</title>
<style>
html,body{padding:0;margin:0;height:100%;}
body{background:#1e1e1e;color:#ddd;font:13px/1.4 system-ui, sans-serif;display:flex;flex-direction:column;}
#toolbar{display:flex;gap:8px;align-items:center;padding:6px 10px;background:#252526;border-bottom:1px solid #333;}
button{background:#3a3d41;color:#ddd;border:1px solid #555;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;}
button:hover{background:#45494e;}
button:active{background:#2d2f33;}
#canvasWrap{flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;background:repeating-conic-gradient(#2a2a2a 0% 25%,#262626 0% 50%) 50% /20px 20px;}
canvas{max-width:100%;max-height:100%;width:auto;height:auto;}
#progress{flex:1;}
label{display:flex;align-items:center;gap:4px;}
#info{margin-left:auto;font-size:11px;opacity:.7;}
select, input[type=range]{cursor:pointer;}
</style>
</head>
<body>
<div id="toolbar">
  <button id="prev">⟨⟨</button>
  <button id="play">▶</button>
  <button id="next">⟩⟩</button>
  <input id="progress" type="range" min="0" max="0" value="0" />
  <label>速度<select id="speed">
    <option value="0.25">0.25x</option>
    <option value="0.5">0.5x</option>
    <option value="1" selected>1x</option>
    <option value="1.5">1.5x</option>
    <option value="2">2x</option>
    <option value="3">3x</option>
    <option value="4">4x</option>
  </select></label>
  <span id="info"></span>
</div>
<div id="canvasWrap"><canvas id="canvas"></canvas></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
<script nonce="${nonce}">
const initialBase64='${base64}';
window.__initialGifBase64 = initialBase64;
window.__isLargeGif = ${large ? 'true' : 'false'};
</script>
</body>
</html>`;
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 16; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
