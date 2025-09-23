## 项目专用 AI 协作指引（GIF Viewer）

本仓库是一个 VS Code 自定义只读编辑器扩展：为 `.gif` 提供可控播放预览。核心分层：
1. 扩展主进程 (`src/extension.ts`)：注册 `gifViewer.viewer` 自定义编辑器；读取文件字节并监听文件更改；向 webview 注入初始数据与配置；通过 `postMessage` 仅发送 base64。
2. Webview 前端 (`webview-src/index.ts`)：用 `gifuct-js` 解析 GIF，手动实现帧合成（含 disposal 0/1/2/3），实现播放控制/缩放/快捷键。打包产物输出到 `media/main.js`（不要直接修改编译文件）。

### 构建 / 调试工作流
- 安装: `npm install`
- 完整构建: `npm run build` （执行 TypeScript 编译 + webview 打包）
- 仅重建 webview: `npm run build-webview`
- 监听开发（扩展+webview）: `npm run watch` （`esbuild --watch` 由脚本参数透传）
- 调试：F5 启动扩展宿主后打开任意 `.gif`，应使用自定义编辑器视图标题 “GIF Viewer”。

### 目录要点
- `src/extension.ts`：唯一入口；`GifDocument` 通过 `workspace.fs.readFile` 支持远程/虚拟文件系统；文件更改由 `FileSystemWatcher` 触发 `reload` 消息。
- `webview-src/index.ts`：不要使用 Node API；消息类型目前：来自扩展 `{ type:'reload', data: base64 }`；webview 初始若无全局 base64，会发送 `{ type:'requestBytes' }`（扩展需在 `onDidReceiveMessage` 中处理）。
- `scripts/build-webview.js`：`esbuild` 浏览器目标打包入口；修改入口或输出路径时同步更新 `extension.ts` 中的 `media/main.js` 引用。

### 配置与安全
- 配置项：`gifViewer.defaultPlaybackSpeed` (0.1–4)。在 `getHtml` 中做边界钳制；新增配置时：1) `package.json.contributes.configuration` 添加属性；2) 在 `getHtml` 读取并注入；3) webview 读取 `window.__initial...`。
- CSP：`script-src 'nonce-<nonce>'` + inline style；新增脚本需复用 nonce；不要引入外域脚本（默认 `default-src 'none'`）。
- 传输策略：仅以 base64 文本在消息通道发送 GIF 数据，避免直接暴露磁盘路径。

### 性能与阈值（保持一致）
- 大文件判定：> 10MB (`extension.ts` 设置 `window.__isLargeGif`)，webview 追加提示。
- 帧数量警示：> 2000 帧显示 ⚠ 提示（`MAX_FRAMES_WARNING`）。
- 帧最小延迟：解析时强制 `Math.max(10, delay)` 避免极短帧过度占用 CPU。

### 帧合成逻辑
`index.ts` 中对每帧：
1. 基于上一合成结果复制全尺寸 RGBA 缓冲区
2. 将 patch（帧矩形区域）写入（跳过 alpha=0 保留底层）
3. 根据 disposalType：2 清除矩形区域；3 恢复到快照；0/1 保留
4. 存储 `ImageData` + 归一化延迟
修改合成算法时保持这些语义，避免闪烁/残影。

### 扩展消息扩展模式
1. 在 `extension.ts` 中扩展 `WebviewInMessage` / `WebviewOutMessage` union。
2. 在 `webview-src/index.ts` 的 `window.addEventListener('message')` 添加 case。
3. 保持消息数据可序列化（避免传输大型对象引用）。

### 添加新功能的常见切入点
- 新的播放选项（循环模式等）：增加配置 -> 注入全局 -> 在 `index.ts` 初始化使用。
- 新的工具栏按钮：修改 `getHtml` 模板（保持最小改动），在 `index.ts` 绑定事件。
- 需要保留隐藏态状态：当前设置 `retainContextWhenHidden: true`，注意内存占用（大型 GIF 同时开启会增压）。如需释放资源，可监听 `visibilitychange` 并在隐藏时暂停播放。

### 不要做的事
- 不要直接编辑 `media/main.js`（自动生成）。
- 不要在 webview 中引用 Node 模块或使用 `require`（打包目标为浏览器）。
- 不要发送未压缩的二进制对象（统一 base64 字符串）。
- 不要在扩展侧缓存帧数组（解析放在 webview，避免主进程内存放大）。

### 快速检查清单（提交前）
- TypeScript 改动后 `npm run build` 通过且生成/更新 `media/main.js`。
- 新增配置项已在 `package.json` + `getHtml` + webview 全局变量串联。
- 消息类型在扩展与 webview 两侧都已添加处理逻辑。
- 未引入破坏 CSP 的外部资源。

欢迎补充：若某段流程不清晰，请指出行号或文件，我们再迭代本指引。