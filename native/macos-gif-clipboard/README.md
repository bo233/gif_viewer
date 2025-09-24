# macOS GIF Clipboard Helper

一个最小的 Swift 命令行工具，将指定 GIF 文件写入系统剪贴板（NSPasteboard, UTI: public.gif）。

## 编译
```bash
swiftc main.swift -o gifclip
```
产物 `gifclip` 将生成在当前目录。

## 使用
```bash
./gifclip /absolute/path/to/file.gif
```
若成功，剪贴板可直接粘贴到支持图片粘贴的应用（如：备忘录、Pages、某些聊天工具）。某些应用可能仍不支持 GIF 粘贴或会转为静态帧。

## 返回码
- 0: 成功
- 1: 参数错误
- 2: 读取文件失败
- 3: 写入剪贴板失败

