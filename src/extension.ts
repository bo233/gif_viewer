import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';

// 记录最近激活的 GIF 自定义编辑器文档 URI（用于复制命令多标签场景判定）
let lastActiveGifUri: vscode.Uri | undefined;

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

interface WebviewOutMessageReload { type: 'reload'; data: string; }
interface WebviewOutMessageCopyResult { type: 'copyResult'; ok: boolean; message: string; }
interface WebviewOutMessageExportTemp { type: 'exportTemp'; name: string; data: string; }
type WebviewOutMessage = WebviewOutMessageReload | WebviewOutMessageCopyResult | WebviewOutMessageExportTemp;

interface WebviewInMessageRequestBytes { type: 'requestBytes'; }
interface WebviewInMessageCopyGif { type: 'copyGif'; }
type WebviewInMessage = WebviewInMessageRequestBytes | WebviewInMessageCopyGif;

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

    // 记录当前激活 GIF（当面板可见/聚焦时）
    webviewPanel.onDidChangeViewState(e => {
      if(e.webviewPanel.active){
        // 保存为最近活动 GIF
        lastActiveGifUri = document.uri;
      }
    });
    // 初次打开也记一次
    if(webviewPanel.active){
      lastActiveGifUri = document.uri;
    }

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
        case 'copyGif': {
          (async () => {
            const filePath = document.uri.fsPath;
            const fileName = path.basename(filePath);
            // Remote 场景：发送 base64 给 webview 做本地剪贴板 (image/gif) 尝试
            if (vscode.env.remoteName) {
              try {
                const bytes = await document.getBytes();
                const base64 = Buffer.from(bytes).toString('base64');
                webviewPanel.webview.postMessage({ type: 'exportTemp', name: fileName, data: base64 } satisfies WebviewOutMessageExportTemp);
                vscode.window.showInformationMessage('已发送 GIF 数据到本地视图，正在尝试写入本地剪贴板: ' + fileName);
                return;
              } catch (e:any) {
                vscode.window.showWarningMessage('远程读取 GIF 失败，回退为路径复制: ' + (e?.message||e));
              }
            }
            // 本地 macOS: 优先 helper
            if(process.platform === 'darwin'){
              const helperPath = path.join(this.context.extensionPath, 'native', 'macos-gif-clipboard', 'gifclip');
              if(fs.existsSync(helperPath)){
                try {
                  await new Promise<void>((resolve, reject) => {
                    const proc = spawn(helperPath, [filePath], { stdio: ['ignore','pipe','pipe'] });
                    let stderr=''; let stdout='';
                    proc.stdout.on('data', d=> stdout += d.toString());
                    proc.stderr.on('data', d=> stderr += d.toString());
                    proc.on('error', reject);
                    proc.on('close', code => {
                      if(code===0) resolve(); else reject(new Error(stderr.trim() || stdout.trim() || ('code '+code)));
                    });
                  });
                  vscode.window.showInformationMessage('GIF 已复制到系统剪贴板 (macOS 图像数据): ' + filePath);
                  webviewPanel.webview.postMessage({ type: 'copyResult', ok: true, message: '' });
                  return;
                } catch(e:any){
                  vscode.window.showWarningMessage('直接写入 GIF 剪贴板失败，已回退为复制路径: ' + (e?.message || e));
                }
              }
            }
            // 路径复制回退
            try {
              await vscode.env.clipboard.writeText(filePath);
              vscode.window.showInformationMessage('GIF 路径已复制: ' + filePath);
              webviewPanel.webview.postMessage({ type: 'copyResult', ok: true, message: '' });
            } catch(err:any){
              vscode.window.showErrorMessage('复制 GIF 路径失败: ' + (err?.message || String(err)));
              webviewPanel.webview.postMessage({ type: 'copyResult', ok: false, message: '复制失败: ' + (err?.message || err) });
            }
          })();
          break;
        }
      }
    });
  }

  private getHtml(webview: vscode.Webview, bytes: Uint8Array, large: boolean): string {
    const config = vscode.workspace.getConfiguration('gifViewer');
    let defaultSpeed = Number(config.get('defaultPlaybackSpeed', 1));
    if(isNaN(defaultSpeed)) defaultSpeed = 1;
    if(defaultSpeed < 0.1) defaultSpeed = 0.1;
    if(defaultSpeed > 4) defaultSpeed = 4;
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
:root{color-scheme:light dark;}
html,body{padding:0;margin:0;height:100%;}
body{
  background:var(--vscode-editor-background);
  color:var(--vscode-foreground);
  font:12px/1.4 var(--vscode-font-family, system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen,Ubuntu,Cantarell,sans-serif);
  display:flex;
  flex-direction:column;
  -webkit-font-smoothing:antialiased;
}
#canvasWrap{
  flex:1;
  display:flex;
  align-items:center;
  justify-content:center;
  overflow:hidden;
  background:var(--vscode-editor-background);
  position:relative;
}
canvas{
  max-width:100%;
  max-height:100%;
  width:auto;
  height:auto;
}
#loadingOverlay{position:absolute;inset:0;display:flex;flex-direction:row;align-items:center;justify-content:center;gap:10px;background:var(--vscode-editor-background);font-size:12px;z-index:10;}
.spinner{width:18px;height:18px;border:3px solid var(--vscode-progressBar-background, var(--vscode-focusBorder,#0078d4));border-top-color:transparent;border-radius:50%;animation:spin 0.9s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}
#toolbar{display:flex;flex-direction:column;gap:10px;background:var(--vscode-sideBar-background, var(--vscode-editor-background));border-top:1px solid var(--vscode-editorGroup-border, var(--vscode-panel-border, rgba(128,128,128,.25)));padding:10px 0 12px;}
#toolbarRow1{display:flex;flex-direction:column;align-items:center;gap:6px;padding:4px 18px 0;}
#toolbarRow1 #progress{width:clamp(240px,70%,1100px);margin:0;}
#frameCounter{font-size:11px;opacity:.8;font-variant-numeric:tabular-nums;}
#toolbarRow2{position:relative;display:flex;justify-content:center;align-items:center;gap:14px;padding:0 18px 2px;}
#btnGroup{display:flex;gap:10px;align-items:center;}
#rightGroup{position:absolute;right:18px;display:flex;align-items:center;gap:14px;max-width:55%;}
button{
  background:var(--vscode-button-secondaryBackground, var(--vscode-button-background,#3a3d41));
  color:var(--vscode-button-foreground, var(--vscode-foreground));
  border:1px solid var(--vscode-button-border, var(--vscode-editorWidget-border, rgba(128,128,128,.35)));
  padding:4px 10px;
  border-radius:4px;
  cursor:pointer;
  font-size:12px;
  line-height:1;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:4px;
  transition:background .12s, transform .1s;
}
button:hover{
  background:var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground,#45494e));
}
button:active{
  background:var(--vscode-button-background,#2d2f33);
  transform:translateY(1px);
}
button:focus-visible{
  outline:1px solid var(--vscode-focusBorder);
  outline-offset:1px;
}
#progress{height:4px;background:transparent;}
input[type=range]{
  -webkit-appearance:none;
  width:100%;
  background:transparent;
  accent-color:var(--vscode-progressBar-background, var(--vscode-focusBorder,#0078d4));
  cursor:pointer;
}
input[type=range]:focus{outline:none;}
input[type=range]::-webkit-slider-runnable-track{
  height:4px;
  background:var(--vscode-scrollbarSlider-background, rgba(127,127,127,.3));
  border-radius:999px;
}
input[type=range]::-webkit-slider-thumb{
  -webkit-appearance:none;
  width:14px;
  height:14px;
  border-radius:50%;
  margin-top:-5px;
  background:var(--vscode-progressBar-background, var(--vscode-focusBorder,#0078d4));
  border:1px solid var(--vscode-editorWidget-border, rgba(0,0,0,.4));
  box-shadow:0 1px 2px rgba(0,0,0,.4);
  cursor:pointer;
  transition:transform .1s, background .15s;
}
input[type=range]:active::-webkit-slider-thumb{
  transform:scale(.9);
}
label{
  display:flex;
  align-items:center;
  gap:4px;
  font-size:12px;
  color:var(--vscode-foreground);
}
select{
  background:var(--vscode-dropdown-background, var(--vscode-input-background,#1e1e1e));
  color:var(--vscode-dropdown-foreground, var(--vscode-foreground));
  border:1px solid var(--vscode-dropdown-border, var(--vscode-input-border, var(--vscode-editorWidget-border, rgba(128,128,128,.35))));
  border-radius:4px;
  padding:2px 4px;
  font-size:12px;
}
select:focus{
  outline:1px solid var(--vscode-focusBorder);
  outline-offset:0;
}
#info{margin-left:0;font-size:11px;opacity:.8;white-space:nowrap;}
@media (max-width:640px){
  #info{display:none;}
}
select, input[type=range]{cursor:pointer;}
/* 固定播放/暂停按钮宽度，防止 ▶ 与 ⏸ 字符宽度差导致跳动 */
#play{
  width:40px;
  padding-left:0;
  padding-right:0;
  display:inline-flex;
  justify-content:center;
}
</style>
</head>
<body>
<div id="canvasWrap"><div id="loadingOverlay"><div class="spinner"></div><span class="loading-text">Loading...</span></div><canvas id="canvas"></canvas></div>
<div id="toolbar">
  <div id="toolbarRow1">
    <input id="progress" type="range" min="0" max="0" value="0" />
    <div id="frameCounter">-- / --</div>
  </div>
  <div id="toolbarRow2">
    <div id="btnGroup">
      <button id="prev">⟨⟨</button>
      <button id="play">▶</button>
      <button id="next">⟩⟩</button>
    </div>
    <div id="rightGroup">
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
  </div>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
<script nonce="${nonce}">
const initialBase64='${base64}';
window.__initialGifBase64 = initialBase64;
window.__isLargeGif = ${large ? 'true' : 'false'};
window.__initialPlaybackSpeed = ${defaultSpeed};
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
